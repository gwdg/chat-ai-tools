# crm-mcp

A local-first CRM [Model Context Protocol](https://modelcontextprotocol.io)
server backed by one SQLite database. It exposes intent-level tools for
contacts, companies, deals, activities, tasks, tags, and pipeline reporting. The
model never gets SQL access.

Every write opens a native confirmation dialog and is recorded in an immutable
audit log with the actor, confirmation mode, and before/after values.

## Requirements

- Node.js 22 or newer. The server uses Node's built-in `node:sqlite`, so there
  is no native SQLite dependency and no separate database server.
- A desktop session for native confirmation dialogs on Linux: `zenity` or
  `kdialog`. macOS uses `osascript`, Windows uses PowerShell/Windows Forms.

## Install and build

```bash
cd crm-mcp
npm install
npm test
npm run build
```

## Run

### Make shortcuts

```bash
make                 # build and run HTTP on 127.0.0.1:8766 with ./crm.db
make start DB=~/crm/crm.db
make status
make stop
make restart
make backup
```

`make start` runs in the foreground. Pass `PASSWORD=...` to set the HTTP bearer
password, `PORT=...` to change the port, or `DEBUG=1` for debug logging.

### stdio

```bash
node dist/index.js --db ~/crm/crm.db
```

Stdio has no transport authentication. Any local process that can start the
server can call its tools. Every write still asks for native confirmation.

### Local HTTP endpoint

```bash
node dist/index.js --http --port 8766 --db ~/crm/crm.db
```

- MCP endpoint: `POST http://127.0.0.1:8766/mcp`
- Health check: `GET http://127.0.0.1:8766/health`
- Bearer auth is required on every MCP request:
  `Authorization: Bearer <token>`.
- The token defaults to the HTTP bearer password, `Zinnober` unless changed.
  Override the password with `--password`, `--ask-password`, or
  `CRM_MCP_PASSWORD`; override the token with `--token` or `CRM_MCP_TOKEN`.
- Localhost/127.0.0.1 browser origins are allowed by default. Use
  `--cors-origin` or `CRM_MCP_CORS_ORIGIN` for other origins. Preflight is
  answered before auth.
- Chat AI config:

```json
{
  "type": "remote",
  "url": "http://127.0.0.1:8766/mcp",
  "headers": { "Authorization": "Bearer <bearer password>" }
}
```

An HTTPS-hosted Chat AI page may block a local HTTP endpoint as mixed content;
serve Chat AI over HTTP on localhost/127.0.0.1 when testing.

## Options

| Option | Environment | Description |
| --- | --- | --- |
| `--db <path>` | `CRM_DB_PATH` | SQLite database path; default `./crm.db`. |
| `--actor <name>` | `CRM_ACTOR` | Audit actor; default `mcp-client`. |
| `--transport <mode>` | `CRM_MCP_TRANSPORT` | `stdio` or `http`. |
| `--http` | | Shorthand for `--transport http`. |
| `--host <host>` | `CRM_MCP_HOST` | HTTP bind address; default `127.0.0.1`. |
| `--port <port>` | `CRM_MCP_PORT` | HTTP port; default `8766`. |
| `--password [password]` | `CRM_MCP_PASSWORD` | HTTP bearer password. Without a value, opens a native password prompt. |
| `--ask-password` | | Open a native password prompt at startup. |
| `--token <token>` | `CRM_MCP_TOKEN` | HTTP bearer token; defaults to the bearer password. |
| `--cors-origin <list>` | `CRM_MCP_CORS_ORIGIN` | Comma-separated allowed browser origins. |
| `--debug` | `CRM_MCP_DEBUG=1` | Log tool calls and errors to stderr. |

## Confirmation and audit

Every write tool calls a native dialog before changing the database. The dialog
offers **Allow for session**, **Allow once**, and **Deny**. Session approval is
kept in memory for that action and entity until the server stops. Denied actions
change nothing.

Each successful write inserts an `audit_log` row containing:

- timestamp and actor
- action name
- entity type and id
- `session` or `once` confirmation mode
- before and after JSON

Use `list_audit_log` to read it. There is no tool that deletes or edits audit
rows. `list_session_approvals` shows the approvals active in the current MCP
session.

## Tools

| Tool | Purpose |
| --- | --- |
| `search_contacts` / `get_contact` | Find contacts; full profile with company, open deals, activity, tags. |
| `create_contact` / `update_contact` / `archive_contact` | Contact writes; dedupe on email; soft archive. |
| `search_companies` / `get_company` | Find companies; full profile with contacts, deals, activity, tags. |
| `create_company` / `update_company` / `archive_company` | Company writes; dedupe on domain; soft archive. |
| `search_deals` / `get_deal` | Find deals; full deal with company, contact, activity, tags. |
| `create_deal` / `update_deal` | Deal writes; stage changes are not allowed here. |
| `move_deal_stage` | Validated stage transition; logs a note activity. |
| `log_activity` | Note, call, email, or meeting linked to an entity. |
| `list_activities` | Paginated timeline with entity, type, and date filters. |
| `create_task` / `complete_task` | Task management with due dates. |
| `pipeline_summary` | Counts, totals, and weighted value by stage and currency. |
| `add_tags` / `remove_tags` | Tags for contacts, companies, or deals. |
| `list_audit_log` | Immutable write history. |
| `list_session_approvals` | Current session approvals. |

List tools are capped at 100 rows and return `next_offset`.

## Resources and prompts

Resources:

- `crm://schema`
- `crm://pipeline`
- `crm://contacts/{id}`
- `crm://companies/{id}`
- `crm://deals/{id}`

Prompts:

- `account_brief(company_id)`
- `weekly_pipeline_review(owner?)`
- `draft_follow_up(contact_id)`

## Data model

- `companies`, `contacts`, `deals`, `activities`
- `tags` and `entity_tags`
- `audit_log`
- `crm_fts` FTS5 index maintained by triggers

IDs are UUIDv7. Timestamps are UTC ISO-8601 text. Money is integer
`amount_cents`. Contacts and companies use soft deletes via `archived_at`.

SQLite runs in WAL mode with foreign keys on, `synchronous=NORMAL`, and a
5000 ms busy timeout. The database directory is created with mode `0700` and the
database file is set to `0600`.

## Backup

Back up a running database with SQLite's backup command:

```bash
backup="$HOME/crm/crm-backup-$(date +%Y%m%d).db"
sqlite3 ~/crm/crm.db "VACUUM INTO '$backup'"
```

The database is local-only. Do not put it on a network drive or share it between
machines; move to Postgres behind the same service layer if that becomes
necessary.

## Safety

- Parameterized SQL only. There is no raw SQL tool.
- Every write is confirmed and audited.
- Deletes are soft archives; no hard-delete tool is exposed.
- CRM notes, names, email bodies, and imported values are untrusted data. Tool
  results include a security notice and never cause side effects.

## Tests

```bash
npm test
```

Tests use in-memory SQLite and a fake confirmation dialog. They never open a
native dialog.
