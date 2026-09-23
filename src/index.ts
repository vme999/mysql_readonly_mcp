#!/usr/bin/env node

import process from "node:process";
import { parseArgs } from "node:util";
import mysql, { type FieldPacket, type RowDataPacket } from "mysql2/promise";
import nodeSqlParser from "node-sql-parser";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

const { Parser } = nodeSqlParser;

const SERVER_NAME = "mysql_readonly_mcp";
const SERVER_VERSION = "0.2.0";
const DEFAULT_LIMIT = 500;
const QUERY_TIMEOUT_MS = 5_000;
const TABLE_LIST_LIMIT = 500;
const SAMPLE_TABLE_DEFAULT_LIMIT = 10;
const SAMPLE_TABLE_MAX_LIMIT = 50;
const VALUE_STRING_MAX_LENGTH = 1_000;
const SYSTEM_DATABASES = ["information_schema", "mysql", "performance_schema", "sys"];

const cliOptionsSchema = z.object({
  host: z.string().min(1),
  port: z.coerce.number().int().positive().default(3306),
  user: z.string().min(1),
  password: z.string(),
  database: z.string().min(1).optional()
});

type CliOptions = z.infer<typeof cliOptionsSchema>;

type QueryResultPayload = {
  columns: string[];
  rows: Record<string, unknown>[];
  rowCount: number;
  limitApplied: number;
  database: string | null;
  configuredDatabase: string | null;
  currentDatabase: string | null;
  referencedDatabases: string[];
  truncated: boolean;
};

type ConnectionInfoPayload = {
  host: string;
  port: number;
  user: string;
  configuredDatabase: string | null;
  currentDatabase: string | null;
  serverName: string;
  serverVersion: string;
  readonly: true;
  queryLimit: number;
  queryTimeoutMs: number;
};

type TableColumnPayload = {
  name: string;
  type: string;
  nullable: boolean;
  key: string;
  default: unknown;
  extra: string;
  comment: string;
};

type TableIndexPayload = {
  name: string;
  unique: boolean;
  columns: string[];
};

type TableForeignKeyPayload = {
  name: string;
  columns: string[];
  referencedDatabase: string;
  referencedTable: string;
  referencedColumns: string[];
  updateRule: string;
  deleteRule: string;
};

type DescribeTablePayload = {
  database: string;
  table: string;
  comment: string;
  rowCountEstimate: number | null;
  dataLength: number | null;
  indexLength: number | null;
  columns: TableColumnPayload[];
  indexes: TableIndexPayload[];
  foreignKeys: TableForeignKeyPayload[];
};

type SchemaOverviewTablePayload = {
  database: string;
  table: string;
  comment: string;
  columns: string[];
  primaryKey: string[];
};

type SchemaOverviewPayload = {
  database: string | null;
  tableCount: number;
  tables: SchemaOverviewTablePayload[];
  limitApplied: number;
};

type ListDatabasesPayload = {
  columns: string[];
  rows: { database: string }[];
  rowCount: number;
  systemDatabasesExcluded: string[];
};

type DescribeDatabasePayload = {
  database: string;
  tableCount: number;
  rowCountEstimate: number | null;
  dataLength: number | null;
  indexLength: number | null;
  tables: {
    table: string;
    comment: string;
    rowCountEstimate: number | null;
    dataLength: number | null;
    indexLength: number | null;
  }[];
  limitApplied: number;
};

type SearchSchemaPayload = {
  keyword: string;
  database: string | null;
  rows: {
    database: string;
    table: string;
    column: string | null;
    matchType: "table" | "column";
    comment: string;
  }[];
  rowCount: number;
  limitApplied: number;
};

const parser = new Parser();

function createToolResponse(payload: object): {
  content: { type: "text"; text: string }[];
  structuredContent: { [key: string]: unknown };
} {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(payload, null, 2)
      }
    ],
    structuredContent: payload as { [key: string]: unknown }
  };
}

function printHelp(): void {
  const lines = [
    `${SERVER_NAME} ${SERVER_VERSION}`,
    "",
    "Usage:",
    "  mysql-readonly-mcp --host <host> --port <port> --user <user> --password <password> [--database <database>]",
    "",
    "Required options:",
    "  --host        MySQL host",
    "  --user        MySQL username",
    "  --password    MySQL password",
    "",
    "Optional options:",
    "  --port        MySQL port (default: 3306)",
    "  --database    Target database. If omitted, all databases visible to the connection may be used.",
    "  --help        Show this help message"
  ];

  console.error(lines.join("\n"));
}

function loadCliOptions(argv: string[]): CliOptions {
  const { values } = parseArgs({
    args: argv,
    options: {
      host: { type: "string" },
      port: { type: "string" },
      user: { type: "string" },
      password: { type: "string" },
      database: { type: "string" },
      help: { type: "boolean", short: "h" }
    },
    allowPositionals: false
  });

  if (values.help) {
    printHelp();
    process.exit(0);
  }

  return cliOptionsSchema.parse(values);
}

function normalizeSql(sql: string): string {
  return sql.trim().replace(/;+$/u, "");
}

function assertQueryUsesOnlyConfiguredDatabase(sql: string, database?: string): void {
  if (!database) {
    return;
  }

  let tableReferences: string[];
  try {
    tableReferences = parser.tableList(sql, { database: "MySQL" });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown SQL parse error.";
    throw new Error(`Invalid SQL table references: ${message}`);
  }

  for (const tableReference of tableReferences) {
    const [, referencedDatabase, referencedTable] = tableReference.split("::");
    if (
      referencedDatabase &&
      referencedDatabase !== "null" &&
      referencedDatabase.toLowerCase() !== database.toLowerCase()
    ) {
      throw new Error(
        `Cross-database table reference is not allowed: ${referencedDatabase}.${referencedTable ?? "*"}`
      );
    }
  }
}

function getReferencedDatabases(sql: string): string[] {
  let tableReferences: string[];
  try {
    tableReferences = parser.tableList(sql, { database: "MySQL" });
  } catch {
    return [];
  }

  const databases = new Set<string>();
  for (const tableReference of tableReferences) {
    const [, referencedDatabase] = tableReference.split("::");
    if (referencedDatabase && referencedDatabase !== "null") {
      databases.add(referencedDatabase);
    }
  }

  return [...databases].sort();
}

function assertReadonlySelect(sql: string, database?: string): string {
  const normalizedSql = normalizeSql(sql);

  if (!normalizedSql) {
    throw new Error("SQL is required.");
  }

  let ast: unknown;
  try {
    ast = parser.astify(normalizedSql, { database: "MySQL" });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown SQL parse error.";
    throw new Error(`Invalid SQL: ${message}`);
  }

  if (Array.isArray(ast)) {
    throw new Error("Only a single SQL statement is allowed.");
  }

  if (!ast || typeof ast !== "object" || !("type" in ast)) {
    throw new Error("Unable to determine SQL statement type.");
  }

  if (ast.type !== "select") {
    throw new Error("Only SELECT or WITH queries that resolve to SELECT are allowed.");
  }

  assertQueryUsesOnlyConfiguredDatabase(normalizedSql, database);

  return normalizedSql;
}

function formatQueryResult(
  rows: RowDataPacket[],
  fields: FieldPacket[],
  metadata: {
    database: string | null;
    configuredDatabase?: string | null;
    currentDatabase?: string | null;
    referencedDatabases?: string[];
  }
): QueryResultPayload {
  let truncated = false;
  const formattedRows = rows.map((row) => {
    const record = row as Record<string, unknown>;
    const formattedRow: Record<string, unknown> = {};

    for (const [key, value] of Object.entries(record)) {
      const formattedValue = formatCellValue(value);
      if (formattedValue.truncated) {
        truncated = true;
      }
      formattedRow[key] = formattedValue.value;
    }

    return formattedRow;
  });

  return {
    columns: fields.map((field) => field.name),
    rows: formattedRows,
    rowCount: rows.length,
    limitApplied: DEFAULT_LIMIT,
    database: metadata.database,
    configuredDatabase: metadata.configuredDatabase ?? null,
    currentDatabase: metadata.currentDatabase ?? null,
    referencedDatabases: metadata.referencedDatabases ?? [],
    truncated
  };
}

function formatTextSummary(result: QueryResultPayload): string {
  return JSON.stringify(
    {
      database: result.database,
      configuredDatabase: result.configuredDatabase,
      currentDatabase: result.currentDatabase,
      referencedDatabases: result.referencedDatabases,
      columns: result.columns,
      rowCount: result.rowCount,
      limitApplied: result.limitApplied,
      truncated: result.truncated,
      rows: result.rows
    },
    null,
    2
  );
}

function getRowValue(row: RowDataPacket, fieldName: string, columnIndex = 0): unknown {
  if (Array.isArray(row)) {
    return row[columnIndex];
  }

  const record = row as Record<string, unknown>;
  if (fieldName in record) {
    return record[fieldName];
  }

  const matchingKey = Object.keys(record).find(
    (key) => key.toLowerCase() === fieldName.toLowerCase()
  );

  return matchingKey ? record[matchingKey] : undefined;
}

function toStringValue(value: unknown): string {
  return value === null || value === undefined ? "" : String(value);
}

function toBooleanFromNumber(value: unknown): boolean {
  return Number(value) !== 0;
}

function toNullableNumber(value: unknown): number | null {
  if (value === null || value === undefined) {
    return null;
  }

  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? numberValue : null;
}

function formatCellValue(value: unknown): { value: unknown; truncated: boolean } {
  if (Buffer.isBuffer(value)) {
    return { value: `<Buffer ${value.length} bytes>`, truncated: value.length > 0 };
  }

  if (typeof value === "string" && value.length > VALUE_STRING_MAX_LENGTH) {
    return {
      value: `${value.slice(0, VALUE_STRING_MAX_LENGTH)}... [truncated ${value.length - VALUE_STRING_MAX_LENGTH} chars]`,
      truncated: true
    };
  }

  return { value, truncated: false };
}

function normalizeOptionalString(value?: string): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}

function resolveScopedDatabase(configuredDatabase?: string, requestedDatabase?: string): string | undefined {
  const normalizedRequestedDatabase = normalizeOptionalString(requestedDatabase);

  if (
    configuredDatabase &&
    normalizedRequestedDatabase &&
    normalizedRequestedDatabase !== configuredDatabase
  ) {
    throw new Error(`Database is restricted to configured database: ${configuredDatabase}`);
  }

  return configuredDatabase ?? normalizedRequestedDatabase;
}

function getSchemaPredicate(database?: string, columnName = "table_schema"): { clause: string; values: string[] } {
  if (database) {
    return { clause: `${columnName} = ?`, values: [database] };
  }

  return {
    clause: `${columnName} NOT IN (${SYSTEM_DATABASES.map(() => "?").join(", ")})`,
    values: SYSTEM_DATABASES
  };
}

function getSchemataPredicate(database?: string): { clause: string; values: string[] } {
  if (database) {
    return { clause: "schema_name = ?", values: [database] };
  }

  return {
    clause: `schema_name NOT IN (${SYSTEM_DATABASES.map(() => "?").join(", ")})`,
    values: SYSTEM_DATABASES
  };
}

function parseTableIdentifier(tableName: string): { database?: string; table: string } {
  const parts = tableName.split(".").map((part) => part.trim()).filter(Boolean);

  if (parts.length === 1) {
    const [table] = parts as [string];
    return { table: table.replace(/^`|`$/gu, "") };
  }

  if (parts.length === 2) {
    const [database, table] = parts as [string, string];
    return {
      database: database.replace(/^`|`$/gu, ""),
      table: table.replace(/^`|`$/gu, "")
    };
  }

  throw new Error(`Invalid table identifier: ${tableName}`);
}

function escapeIdentifier(identifier: string): string {
  return `\`${identifier.replace(/`/gu, "``")}\``;
}

async function assertBaseTableExists(
  connection: mysql.Connection,
  tableName: string,
  configuredDatabase?: string,
  requestedDatabase?: string
): Promise<{ database: string; table: string }> {
  const parsedTable = parseTableIdentifier(tableName);
  const targetDatabase = resolveScopedDatabase(configuredDatabase, requestedDatabase ?? parsedTable.database);

  if (requestedDatabase && parsedTable.database && parsedTable.database !== requestedDatabase) {
    throw new Error(`Table database does not match requested database: ${requestedDatabase}`);
  }

  const schemaPredicate = getSchemaPredicate(targetDatabase);
  const [rows, fields] = await connection.query<RowDataPacket[]>(
    `
      SELECT table_schema AS table_schema, table_name AS table_name
      FROM information_schema.tables
      WHERE ${schemaPredicate.clause}
        AND table_type = 'BASE TABLE'
        AND table_name = ?
      ORDER BY table_schema, table_name
      LIMIT 2
    `,
    [...schemaPredicate.values, parsedTable.table]
  );

  if (rows.length > 1) {
    const candidates = rows
      .map((row) => `${toStringValue(getRowValue(row, "table_schema"))}.${toStringValue(getRowValue(row, "table_name"))}`)
      .join(", ");
    throw new Error(
      `Table name is ambiguous across databases. Specify database for table: ${tableName}. Candidates: ${candidates}`
    );
  }

  const schemaFieldName = (fields as FieldPacket[])[0]?.name ?? "table_schema";
  const tableFieldName = (fields as FieldPacket[])[1]?.name ?? "table_name";
  const resolvedDatabase = rows[0] ? getRowValue(rows[0], schemaFieldName) : null;
  const resolvedTableName = rows[0] ? getRowValue(rows[0], tableFieldName) : null;

  if (!resolvedDatabase || !resolvedTableName) {
    const scope = targetDatabase ? `database ${targetDatabase}` : "visible databases";
    throw new Error(`Table not found in ${scope}: ${tableName}`);
  }

  return { database: String(resolvedDatabase), table: String(resolvedTableName) };
}

async function getCurrentDatabase(connection: mysql.Connection): Promise<string | null> {
  const [rows, fields] = await connection.query<RowDataPacket[]>("SELECT DATABASE() AS current_database");
  const fieldName = (fields as FieldPacket[])[0]?.name ?? "current_database";
  const currentDatabase = rows[0] ? getRowValue(rows[0], fieldName) : null;

  return currentDatabase === null || currentDatabase === undefined ? null : String(currentDatabase);
}

async function runSelectQuery(connection: mysql.Connection, sql: string, database?: string) {
  const readonlySql = assertReadonlySelect(sql, database);
  const currentDatabase = await getCurrentDatabase(connection);

  await connection.query("SET SESSION sql_select_limit = ?", [DEFAULT_LIMIT]);
  await connection.query("SET SESSION max_execution_time = ?", [QUERY_TIMEOUT_MS]);

  const [rows, fields] = await connection.query<RowDataPacket[]>({
    sql: readonlySql,
    timeout: QUERY_TIMEOUT_MS
  });

  return formatQueryResult(rows, fields as FieldPacket[], {
    database: database ?? currentDatabase,
    configuredDatabase: database ?? null,
    currentDatabase,
    referencedDatabases: getReferencedDatabases(readonlySql)
  });
}

async function getConnectionInfo(
  connection: mysql.Connection,
  options: CliOptions
): Promise<ConnectionInfoPayload> {
  const currentDatabase = await getCurrentDatabase(connection);

  return {
    host: options.host,
    port: options.port,
    user: options.user,
    configuredDatabase: options.database ?? null,
    currentDatabase,
    serverName: SERVER_NAME,
    serverVersion: SERVER_VERSION,
    readonly: true,
    queryLimit: DEFAULT_LIMIT,
    queryTimeoutMs: QUERY_TIMEOUT_MS
  };
}

async function describeTable(
  connection: mysql.Connection,
  tableName: string,
  configuredDatabase?: string,
  requestedDatabase?: string
): Promise<DescribeTablePayload> {
  const resolvedTable = await assertBaseTableExists(
    connection,
    tableName,
    configuredDatabase,
    requestedDatabase
  );

  const [tableRows] = await connection.query<RowDataPacket[]>(
    `
      SELECT
        table_comment AS table_comment,
        table_rows AS table_rows,
        data_length AS data_length,
        index_length AS index_length
      FROM information_schema.tables
      WHERE table_schema = ?
        AND table_name = ?
      LIMIT 1
    `,
    [resolvedTable.database, resolvedTable.table]
  );

  const [columnRows] = await connection.query<RowDataPacket[]>(
    `
      SELECT
        column_name AS column_name,
        column_type AS column_type,
        is_nullable AS is_nullable,
        column_key AS column_key,
        column_default AS column_default,
        extra AS extra,
        column_comment AS column_comment
      FROM information_schema.columns
      WHERE table_schema = ?
        AND table_name = ?
      ORDER BY ordinal_position
    `,
    [resolvedTable.database, resolvedTable.table]
  );

  const [indexRows] = await connection.query<RowDataPacket[]>(
    `
      SELECT
        index_name AS index_name,
        non_unique AS non_unique,
        column_name AS column_name,
        seq_in_index AS seq_in_index
      FROM information_schema.statistics
      WHERE table_schema = ?
        AND table_name = ?
      ORDER BY index_name, seq_in_index
    `,
    [resolvedTable.database, resolvedTable.table]
  );

  const [foreignKeyRows] = await connection.query<RowDataPacket[]>(
    `
      SELECT
        kcu.constraint_name AS constraint_name,
        kcu.column_name AS column_name,
        kcu.referenced_table_schema AS referenced_table_schema,
        kcu.referenced_table_name AS referenced_table_name,
        kcu.referenced_column_name AS referenced_column_name,
        kcu.ordinal_position AS ordinal_position,
        rc.update_rule AS update_rule,
        rc.delete_rule AS delete_rule
      FROM information_schema.key_column_usage kcu
      JOIN information_schema.referential_constraints rc
        ON rc.constraint_schema = kcu.constraint_schema
       AND rc.constraint_name = kcu.constraint_name
       AND rc.table_name = kcu.table_name
      WHERE kcu.table_schema = ?
        AND kcu.table_name = ?
        AND kcu.referenced_table_name IS NOT NULL
      ORDER BY kcu.constraint_name, kcu.ordinal_position
    `,
    [resolvedTable.database, resolvedTable.table]
  );

  const indexMap = new Map<string, TableIndexPayload>();
  for (const row of indexRows) {
    const indexName = toStringValue(getRowValue(row, "index_name"));
    const indexColumn = toStringValue(getRowValue(row, "column_name"));
    const nonUnique = getRowValue(row, "non_unique");
    const indexPayload = indexMap.get(indexName) ?? {
      name: indexName,
      unique: !toBooleanFromNumber(nonUnique),
      columns: []
    };

    indexPayload.columns.push(indexColumn);
    indexMap.set(indexName, indexPayload);
  }

  const foreignKeyMap = new Map<string, TableForeignKeyPayload>();
  for (const row of foreignKeyRows) {
    const foreignKeyName = toStringValue(getRowValue(row, "constraint_name"));
    const foreignKeyPayload = foreignKeyMap.get(foreignKeyName) ?? {
      name: foreignKeyName,
      columns: [],
      referencedDatabase: toStringValue(getRowValue(row, "referenced_table_schema")),
      referencedTable: toStringValue(getRowValue(row, "referenced_table_name")),
      referencedColumns: [],
      updateRule: toStringValue(getRowValue(row, "update_rule")),
      deleteRule: toStringValue(getRowValue(row, "delete_rule"))
    };

    foreignKeyPayload.columns.push(toStringValue(getRowValue(row, "column_name")));
    foreignKeyPayload.referencedColumns.push(toStringValue(getRowValue(row, "referenced_column_name")));
    foreignKeyMap.set(foreignKeyName, foreignKeyPayload);
  }

  const tableMetadata = tableRows[0];

  return {
    database: resolvedTable.database,
    table: resolvedTable.table,
    comment: tableMetadata ? toStringValue(getRowValue(tableMetadata, "table_comment")) : "",
    rowCountEstimate: tableMetadata ? toNullableNumber(getRowValue(tableMetadata, "table_rows")) : null,
    dataLength: tableMetadata ? toNullableNumber(getRowValue(tableMetadata, "data_length")) : null,
    indexLength: tableMetadata ? toNullableNumber(getRowValue(tableMetadata, "index_length")) : null,
    columns: columnRows.map((row) => ({
      name: toStringValue(getRowValue(row, "column_name")),
      type: toStringValue(getRowValue(row, "column_type")),
      nullable: toStringValue(getRowValue(row, "is_nullable")).toUpperCase() === "YES",
      key: toStringValue(getRowValue(row, "column_key")),
      default: getRowValue(row, "column_default"),
      extra: toStringValue(getRowValue(row, "extra")),
      comment: toStringValue(getRowValue(row, "column_comment"))
    })),
    indexes: [...indexMap.values()],
    foreignKeys: [...foreignKeyMap.values()]
  };
}

async function getSchemaOverview(
  connection: mysql.Connection,
  configuredDatabase?: string,
  requestedDatabase?: string
): Promise<SchemaOverviewPayload> {
  const database = resolveScopedDatabase(configuredDatabase, requestedDatabase);
  const schemaPredicate = getSchemaPredicate(database);
  const [tableRows] = await connection.query<RowDataPacket[]>(
    `
      SELECT table_schema AS table_schema, table_name AS table_name, table_comment AS table_comment
      FROM information_schema.tables
      WHERE ${schemaPredicate.clause}
        AND table_type = 'BASE TABLE'
      ORDER BY table_schema, table_name
      LIMIT ?
    `,
    [...schemaPredicate.values, TABLE_LIST_LIMIT]
  );

  const [columnRows] = await connection.query<RowDataPacket[]>(
    `
      SELECT
        table_schema AS table_schema,
        table_name AS table_name,
        column_name AS column_name,
        column_type AS column_type,
        column_key AS column_key
      FROM information_schema.columns
      WHERE ${schemaPredicate.clause}
      ORDER BY table_schema, table_name, ordinal_position
    `,
    schemaPredicate.values
  );

  const columnMap = new Map<string, { columns: string[]; primaryKey: string[] }>();
  for (const row of columnRows) {
    const databaseName = toStringValue(getRowValue(row, "table_schema"));
    const tableName = toStringValue(getRowValue(row, "table_name"));
    const columnName = toStringValue(getRowValue(row, "column_name"));
    const columnType = toStringValue(getRowValue(row, "column_type"));
    const columnKey = toStringValue(getRowValue(row, "column_key"));
    const mapKey = `${databaseName}.${tableName}`;
    const entry = columnMap.get(mapKey) ?? { columns: [], primaryKey: [] };

    entry.columns.push(`${columnName} ${columnType}`);
    if (columnKey === "PRI") {
      entry.primaryKey.push(columnName);
    }
    columnMap.set(mapKey, entry);
  }

  return {
    database: database ?? null,
    tableCount: tableRows.length,
    tables: tableRows.map((row) => {
      const databaseName = toStringValue(getRowValue(row, "table_schema"));
      const tableName = toStringValue(getRowValue(row, "table_name"));
      const columns = columnMap.get(`${databaseName}.${tableName}`) ?? { columns: [], primaryKey: [] };

      return {
        database: databaseName,
        table: tableName,
        comment: toStringValue(getRowValue(row, "table_comment")),
        columns: columns.columns,
        primaryKey: columns.primaryKey
      };
    }),
    limitApplied: TABLE_LIST_LIMIT
  };
}

async function listDatabases(
  connection: mysql.Connection,
  configuredDatabase?: string
): Promise<ListDatabasesPayload> {
  const schemataPredicate = getSchemataPredicate(configuredDatabase);
  const [rows, fields] = await connection.query<RowDataPacket[]>(
    `
      SELECT schema_name AS schema_name
      FROM information_schema.schemata
      WHERE ${schemataPredicate.clause}
      ORDER BY schema_name
    `,
    schemataPredicate.values
  );

  const fieldName = (fields as FieldPacket[])[0]?.name ?? "schema_name";
  const databaseRows = rows.map((row) => ({
    database: String(getRowValue(row, fieldName) ?? "")
  }));

  return {
    columns: ["database"],
    rows: databaseRows,
    rowCount: databaseRows.length,
    systemDatabasesExcluded: configuredDatabase ? [] : SYSTEM_DATABASES
  };
}

async function describeDatabase(
  connection: mysql.Connection,
  configuredDatabase: string | undefined,
  requestedDatabase: string
): Promise<DescribeDatabasePayload> {
  const database = resolveScopedDatabase(configuredDatabase, requestedDatabase);
  if (!database) {
    throw new Error("Database is required.");
  }

  const [summaryRows] = await connection.query<RowDataPacket[]>(
    `
      SELECT
        COUNT(*) AS table_count,
        SUM(table_rows) AS table_rows,
        SUM(data_length) AS data_length,
        SUM(index_length) AS index_length
      FROM information_schema.tables
      WHERE table_schema = ?
        AND table_type = 'BASE TABLE'
    `,
    [database]
  );

  const [tableRows] = await connection.query<RowDataPacket[]>(
    `
      SELECT
        table_name AS table_name,
        table_comment AS table_comment,
        table_rows AS table_rows,
        data_length AS data_length,
        index_length AS index_length
      FROM information_schema.tables
      WHERE table_schema = ?
        AND table_type = 'BASE TABLE'
      ORDER BY table_name
      LIMIT ?
    `,
    [database, TABLE_LIST_LIMIT]
  );

  const tables = tableRows.map((row) => {
    const rowCountEstimate = toNullableNumber(getRowValue(row, "table_rows"));
    const dataLength = toNullableNumber(getRowValue(row, "data_length"));
    const indexLength = toNullableNumber(getRowValue(row, "index_length"));

    return {
      table: toStringValue(getRowValue(row, "table_name")),
      comment: toStringValue(getRowValue(row, "table_comment")),
      rowCountEstimate,
      dataLength,
      indexLength
    };
  });
  const summary = summaryRows[0];

  return {
    database,
    tableCount: summary ? Number(getRowValue(summary, "table_count")) : 0,
    rowCountEstimate: summary ? toNullableNumber(getRowValue(summary, "table_rows")) : null,
    dataLength: summary ? toNullableNumber(getRowValue(summary, "data_length")) : null,
    indexLength: summary ? toNullableNumber(getRowValue(summary, "index_length")) : null,
    tables,
    limitApplied: TABLE_LIST_LIMIT
  };
}

async function searchSchema(
  connection: mysql.Connection,
  keyword: string,
  configuredDatabase?: string,
  requestedDatabase?: string
): Promise<SearchSchemaPayload> {
  const database = resolveScopedDatabase(configuredDatabase, requestedDatabase);
  const tableSchemaPredicate = getSchemaPredicate(database, "t.table_schema");
  const columnSchemaPredicate = getSchemaPredicate(database, "c.table_schema");
  const searchPattern = `%${keyword}%`;
  const [rows] = await connection.query<RowDataPacket[]>(
    `
      SELECT
        t.table_schema AS table_schema,
        t.table_name AS table_name,
        NULL AS column_name,
        'table' AS match_type,
        t.table_comment AS comment
      FROM information_schema.tables t
      WHERE ${tableSchemaPredicate.clause}
        AND t.table_type = 'BASE TABLE'
        AND (t.table_name LIKE ? OR t.table_comment LIKE ?)
      UNION ALL
      SELECT
        c.table_schema AS table_schema,
        c.table_name AS table_name,
        c.column_name AS column_name,
        'column' AS match_type,
        c.column_comment AS comment
      FROM information_schema.columns c
      JOIN information_schema.tables t
        ON t.table_schema = c.table_schema
       AND t.table_name = c.table_name
      WHERE ${columnSchemaPredicate.clause}
        AND t.table_type = 'BASE TABLE'
        AND (c.column_name LIKE ? OR c.column_comment LIKE ?)
      ORDER BY table_schema, table_name, match_type, column_name
      LIMIT ?
    `,
    [
      ...tableSchemaPredicate.values,
      searchPattern,
      searchPattern,
      ...columnSchemaPredicate.values,
      searchPattern,
      searchPattern,
      TABLE_LIST_LIMIT
    ]
  );

  return {
    keyword,
    database: database ?? null,
    rows: rows.map((row) => ({
      database: toStringValue(getRowValue(row, "table_schema")),
      table: toStringValue(getRowValue(row, "table_name")),
      column: getRowValue(row, "column_name") === null ? null : toStringValue(getRowValue(row, "column_name")),
      matchType: toStringValue(getRowValue(row, "match_type")) === "table" ? "table" : "column",
      comment: toStringValue(getRowValue(row, "comment"))
    })),
    rowCount: rows.length,
    limitApplied: TABLE_LIST_LIMIT
  };
}

async function sampleTable(
  connection: mysql.Connection,
  tableName: string,
  requestedLimit: number,
  configuredDatabase?: string,
  requestedDatabase?: string,
  requestedColumns?: string[]
): Promise<QueryResultPayload> {
  const resolvedTable = await assertBaseTableExists(
    connection,
    tableName,
    configuredDatabase,
    requestedDatabase
  );
  const limit = Math.min(requestedLimit, SAMPLE_TABLE_MAX_LIMIT);
  let columnsSql = "*";

  if (requestedColumns && requestedColumns.length > 0) {
    const normalizedColumns = [...new Set(requestedColumns.map((column) => column.trim()).filter(Boolean))];

    if (normalizedColumns.length === 0) {
      throw new Error("Columns must not be empty.");
    }

    const [columnRows] = await connection.query<RowDataPacket[]>(
      `
        SELECT column_name AS column_name
        FROM information_schema.columns
        WHERE table_schema = ?
          AND table_name = ?
          AND column_name IN (${normalizedColumns.map(() => "?").join(", ")})
      `,
      [resolvedTable.database, resolvedTable.table, ...normalizedColumns]
    );
    const existingColumns = new Set(
      columnRows.map((row) => toStringValue(getRowValue(row, "column_name")).toLowerCase())
    );
    const missingColumns = normalizedColumns.filter(
      (column) => !existingColumns.has(column.toLowerCase())
    );

    if (missingColumns.length > 0) {
      throw new Error(`Columns not found in ${resolvedTable.database}.${resolvedTable.table}: ${missingColumns.join(", ")}`);
    }

    columnsSql = normalizedColumns.map(escapeIdentifier).join(", ");
  }

  const [rows, fields] = await connection.query<RowDataPacket[]>({
    sql: `SELECT ${columnsSql} FROM ${escapeIdentifier(resolvedTable.database)}.${escapeIdentifier(resolvedTable.table)} LIMIT ?`,
    values: [limit],
    timeout: QUERY_TIMEOUT_MS
  });

  return {
    ...formatQueryResult(rows, fields as FieldPacket[], {
      database: resolvedTable.database,
      configuredDatabase: configuredDatabase ?? null,
      currentDatabase: await getCurrentDatabase(connection),
      referencedDatabases: [resolvedTable.database]
    }),
    limitApplied: limit
  };
}

async function explainSelectQuery(connection: mysql.Connection, sql: string, database?: string) {
  const readonlySql = assertReadonlySelect(sql, database);
  const currentDatabase = await getCurrentDatabase(connection);
  const [rows, fields] = await connection.query<RowDataPacket[]>({
    sql: `EXPLAIN ${readonlySql}`,
    timeout: QUERY_TIMEOUT_MS
  });

  return formatQueryResult(rows, fields as FieldPacket[], {
    database: database ?? currentDatabase,
    configuredDatabase: database ?? null,
    currentDatabase,
    referencedDatabases: getReferencedDatabases(readonlySql)
  });
}

async function main() {
  const options = loadCliOptions(process.argv.slice(2));

  const connection = await mysql.createConnection({
    host: options.host,
    port: options.port,
    user: options.user,
    password: options.password,
    ...(options.database ? { database: options.database } : {}),
    multipleStatements: false,
    connectTimeout: QUERY_TIMEOUT_MS
  });

  const server = new McpServer({
    name: SERVER_NAME,
    version: SERVER_VERSION
  });

  server.tool(
    "get_connection_info",
    "Show the non-sensitive MySQL connection metadata for this MCP server.",
    {},
    async () => {
      const payload = await getConnectionInfo(connection, options);

      return createToolResponse(payload);
    }
  );

  server.tool(
    "list_databases",
    "List databases visible to the current MySQL connection, excluding system databases unless a startup database is configured.",
    {},
    async () => {
      const payload = await listDatabases(connection, options.database);

      return createToolResponse(payload);
    }
  );

  server.tool(
    "describe_database",
    "Describe one database with table counts, row estimates, and size estimates.",
    {
      database: z.string().min(1).describe("Database to describe.")
    },
    async ({ database }) => {
      const payload = await describeDatabase(connection, options.database, database);

      return createToolResponse(payload);
    }
  );

  server.tool(
    "list_tables",
    "List base tables in the configured MySQL database, or all visible databases when no database is configured.",
    {
      database: z
        .string()
        .min(1)
        .optional()
        .describe("Database to list when no startup database is configured."),
      search: z
        .string()
        .min(1)
        .optional()
        .describe("Optional table name search text."),
      limit: z
        .number()
        .int()
        .positive()
        .max(TABLE_LIST_LIMIT)
        .default(TABLE_LIST_LIMIT)
        .describe("Maximum tables to return.")
    },
    async ({ database, search, limit }) => {
      const scopedDatabase = resolveScopedDatabase(options.database, database);
      const schemaPredicate = getSchemaPredicate(scopedDatabase);
      const searchClause = search ? "AND table_name LIKE ?" : "";
      const searchValues = search ? [`%${search}%`] : [];
      const [rows, fields] = await connection.query<RowDataPacket[]>(
        `
          SELECT table_schema AS table_schema, table_name AS table_name
          FROM information_schema.tables
          WHERE ${schemaPredicate.clause}
            AND table_type = 'BASE TABLE'
            ${searchClause}
          ORDER BY table_schema, table_name
          LIMIT ?
        `,
        [...schemaPredicate.values, ...searchValues, limit]
      );

      const databaseFieldName = (fields as FieldPacket[])[0]?.name ?? "table_schema";
      const tableFieldName = (fields as FieldPacket[])[1]?.name ?? "table_name";
      const payload = {
        database: scopedDatabase ?? null,
        search: search ?? null,
        columns: ["database", "table_name"],
        rows: rows.map((row) => ({
          database: String(getRowValue(row, databaseFieldName) ?? ""),
          table_name: String(getRowValue(row, tableFieldName) ?? "")
        })),
        rowCount: rows.length,
        limitApplied: limit,
        systemDatabasesExcluded: scopedDatabase ? [] : SYSTEM_DATABASES
      };

      return createToolResponse(payload);
    }
  );

  server.tool(
    "search_schema",
    "Search visible table names, column names, and comments.",
    {
      keyword: z.string().min(1).describe("Keyword to search for in table names, column names, and comments."),
      database: z
        .string()
        .min(1)
        .optional()
        .describe("Database to search when no startup database is configured.")
    },
    async ({ keyword, database }) => {
      const payload = await searchSchema(connection, keyword, options.database, database);

      return createToolResponse(payload);
    }
  );

  server.tool(
    "describe_table",
    "Describe a base table in the configured MySQL database, or a visible database when no database is configured.",
    {
      table: z.string().min(1).describe("A base table name, optionally qualified as database.table."),
      database: z
        .string()
        .min(1)
        .optional()
        .describe("Database to use when no startup database is configured.")
    },
    async ({ table, database }) => {
      const payload = await describeTable(connection, table, options.database, database);

      return createToolResponse(payload);
    }
  );

  server.tool(
    "get_schema_overview",
    "Return a compact overview of base tables, columns, comments, and primary keys in scope.",
    {
      database: z
        .string()
        .min(1)
        .optional()
        .describe("Database to inspect when no startup database is configured.")
    },
    async ({ database }) => {
      const payload = await getSchemaOverview(connection, options.database, database);

      return createToolResponse(payload);
    }
  );

  server.tool(
    "sample_table",
    "Return a small sample of rows from a base table in scope.",
    {
      table: z.string().min(1).describe("A base table name, optionally qualified as database.table."),
      database: z
        .string()
        .min(1)
        .optional()
        .describe("Database to use when no startup database is configured."),
      columns: z
        .array(z.string().min(1))
        .optional()
        .describe("Optional column names to return instead of SELECT *."),
      limit: z
        .number()
        .int()
        .positive()
        .max(SAMPLE_TABLE_MAX_LIMIT)
        .default(SAMPLE_TABLE_DEFAULT_LIMIT)
        .describe("Maximum sample rows to return.")
    },
    async ({ table, database, columns, limit }) => {
      const payload = await sampleTable(connection, table, limit, options.database, database, columns);

      return createToolResponse(payload);
    }
  );

  server.tool(
    "query_select",
    "Run a single read-only SELECT/WITH query against the configured MySQL database, or visible databases when no database is configured.",
    {
      sql: z.string().min(1).describe("A single SELECT or WITH query.")
    },
    async ({ sql }) => {
      const result = await runSelectQuery(connection, sql, options.database);

      return {
        ...createToolResponse(result),
        content: [
          {
            type: "text",
            text: formatTextSummary(result)
          }
        ]
      };
    }
  );

  server.tool(
    "explain_select",
    "Run EXPLAIN for a single read-only SELECT/WITH query without returning table data.",
    {
      sql: z.string().min(1).describe("A single SELECT or WITH query to explain.")
    },
    async ({ sql }) => {
      const result = await explainSelectQuery(connection, sql, options.database);

      return createToolResponse(result);
    }
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);

  const shutdown = async () => {
    await server.close();
    await connection.end();
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}

main().catch((error: unknown) => {
  if (error instanceof z.ZodError) {
    printHelp();
  }

  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  console.error(message);
  process.exit(1);
});
