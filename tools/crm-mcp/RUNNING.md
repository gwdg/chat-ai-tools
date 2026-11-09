# Running crm-mcp

Short guide. Full details are in [README.md](README.md).

## 1. Build

```bash
cd /absolute/path/to/crm-mcp
npm install
npm run build
```

Node.js 22 or newer is required because the server uses the built-in
`node:sqlite` module.

## 2. Start it

### stdio

```bash
node dist/index.js --db ~/crm/crm.db
```

Stdio has no transport authentication. Every write still asks for native
confirmation.

### HTTP

```bash
node dist/index.js --http --port 8766 --db ~/crm/crm.db
```

Or use the Makefile:

```bash
make start DB=~/crm/crm.db
make status
make stop
```

- MCP: `POST http://127.0.0.1:8766/mcp`
- Health: `GET http://127.0.0.1:8766/health`
- Send `Authorization: Bearer <token>` on every MCP request.
- The token defaults to the HTTP bearer password, `Zinnober` unless changed with
  `--password`, `--ask-password`, or `CRM_MCP_PASSWORD`.
- Override the token with `--token` or `CRM_MCP_TOKEN`.
- Localhost browser origins and `*.chat-ai.academiccloud.de` are allowed by
  default. Use `--cors-origin` or `CRM_MCP_CORS_ORIGIN` for another origin;
  patterns support `*` and `*.domain` wildcards.

Chat AI configuration:

```json
{
  "type": "remote",
  "url": "http://127.0.0.1:8766/mcp",
  "headers": { "Authorization": "Bearer <bearer password>" }
}
```

## 3. Confirmations

Every write opens a native dialog. Choose **Allow for session**, **Allow once**,
or **Deny**. A denied action changes nothing. Session approvals last until the
server stops and are listed by `list_session_approvals`.

The confirmation dialog must be available in the same desktop session as the
server. On Linux install `zenity` or `kdialog`; macOS and Windows use built-in
dialogs. On a headless machine, writes fail with a dialog error and no data is
changed.

## 4. Audit

Every confirmed write is stored in `audit_log` with actor, action, entity,
confirmation mode, and before/after JSON. Read it through the
`list_audit_log` tool. There is no tool to edit or delete audit rows.

## 5. Database

The default database is `./crm.db`. Set another path with `--db` or
`CRM_DB_PATH`. SQLite uses WAL mode; back it up with `VACUUM INTO` rather than
copying the live file. Do not place it on a network drive.

## 6. Quick check

```bash
npm test
curl -s http://127.0.0.1:8766/health
```
