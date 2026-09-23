# mysql_readonly_mcp

Read-only MySQL MCP server implemented in TypeScript.

Package: `@vme999/mysql-readonly-mcp`

## Safety

- Allows only one `SELECT` or `WITH ... SELECT` statement per call.
- Blocks writes, schema changes, transactions, and database switching.
- If `--database` is set, all tools are restricted to that database.
- If `--database` is omitted, metadata tools use visible non-system databases.
- Excludes `information_schema`, `mysql`, `performance_schema`, and `sys` by default.
- Applies a 500-row query limit, 5-second timeout, and long-value truncation.

## Tools

| Tool | Purpose |
| --- | --- |
| `get_connection_info()` | Show non-sensitive connection metadata |
| `list_databases()` | List visible databases in scope |
| `describe_database(database)` | Summarize table count, row estimates, and sizes |
| `list_tables(database?, search?, limit?)` | List base tables |
| `describe_table(table, database?)` | Show columns, indexes, foreign keys, row and size estimates |
| `get_schema_overview(database?)` | Show compact table and column overview |
| `search_schema(keyword, database?)` | Search table names, column names, and comments |
| `sample_table(table, database?, columns?, limit?)` | Return up to 50 sample rows |
| `query_select(sql)` | Run a guarded read-only query |
| `explain_select(sql)` | Run `EXPLAIN` without returning table data |

## Setup

```bash
npm install
npm run build
```

## Run

Single-database mode:

```bash
npm run dev -- --host <host> --user <user> --password <password> --database <database>
```

All visible non-system databases:

```bash
npm run dev -- --host <host> --user <user> --password <password>
```

Production or npm package:

```bash
npm start -- --host <host> --user <user> --password <password> --database <database>
npx -y @vme999/mysql-readonly-mcp --host <host> --user <user> --password <password> --database <database>
```

Options: `--host`, `--port`, `--user`, `--password`, optional `--database`, `--help`.

## Cursor Example

Prefer environment variables so credentials are not stored in plain text.

```json
{
  "mcpServers": {
    "mysql_readonly_mcp": {
      "type": "stdio",
      "command": "npx",
      "args": [
        "-y",
        "@vme999/mysql-readonly-mcp",
        "--host", "${env:MYSQL_HOST}",
        "--port", "${env:MYSQL_PORT}",
        "--user", "${env:MYSQL_USER}",
        "--password", "${env:MYSQL_PASSWORD}",
        "--database", "${env:MYSQL_DATABASE}"
      ]
    }
  }
}
```
