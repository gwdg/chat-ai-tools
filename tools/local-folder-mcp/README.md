# Local folder MCP server

A small, dependency-free MCP server that gives an AI client **read-only** access
to local folders. Every new folder must be approved by the user in a native
confirmation dialog. Approved folders are remembered only for the lifetime of
the server process.

## Requirements

- Node.js 18 or newer.
- A desktop session where a native dialog can appear:
  - **Windows:** Windows PowerShell with Windows Forms (built in).
  - **macOS:** `osascript` (built in).
  - **Linux:** `zenity` or `kdialog` installed. Headless Linux cannot show the
    confirmation dialog, so access is denied with an error.

No npm dependencies.

On Windows, the repository can build a standalone `local-folder-mcp.exe` with
`npm run build:windows`; see the root [README-Windows.txt](../../README-Windows.txt)
for the full build and installation guide.

## Network

The server supports two local transports:

- **stdio** — the MCP client starts `server.mjs` as a child process. No network
  listener is opened.
- **Streamable HTTP** — for URL-based clients such as Chat AI. It binds to
  `127.0.0.1` only and prints its endpoint on startup.

Neither mode is reachable over the internet.

## HTTP mode for Chat AI

From the repository root:

```bash
npm run mcp:folder
```

It prints:

```text
local-folder-mcp HTTP server listening on 127.0.0.1:3921
Use the following MCP endpoint in Chat AI:
http://127.0.0.1:3921/mcp
```

Paste that URL into Chat AI’s MCP server settings. The endpoint speaks
Streamable HTTP:

- `POST /mcp` — JSON-RPC requests and notifications
- `GET /mcp` — returns 405; this server sends no server-initiated SSE
- `DELETE /mcp` — accepted for session termination
- `GET /health` — `{ "ok": true }`

The port can be changed with `MCP_FOLDER_HTTP_PORT`. CORS accepts
localhost/127.0.0.1 origins and `*.chat-ai.academiccloud.de` by default; set
`MCP_FOLDER_CORS_ORIGIN` to a comma-separated list to override that. Patterns
support `*` and `*.domain` wildcards.

## stdio client configuration

Add the server to your MCP client configuration as a command. Use an absolute
path to `server.mjs`.

macOS / Linux:

```json
{
  "mcpServers": {
    "local-folders": {
      "command": "node",
      "args": ["/absolute/path/to/chat-ai-tools/tools/local-folder-mcp/server.mjs"]
    }
  }
}
```

Windows:

```json
{
  "mcpServers": {
    "local-folders": {
      "command": "node",
      "args": ["C:\\absolute\\path\\to\\chat-ai-tools\\tools\\local-folder-mcp\\server.mjs"]
    }
  }
}
```

The `command`/`args` form above runs the server in stdio mode. You can start the
same mode manually with:

```bash
npm run mcp:folder:stdio
```

It waits for JSON-RPC messages on stdin.

## Tools

| Tool | What it does |
|---|---|
| `request_folder_access` | Asks the user to allow a folder for the session. |
| `list_folder` | Lists files, folders, sizes, and modification times. Prompts first if the folder is not allowed. |
| `read_file` | Reads a UTF-8 text file. Prompts for its folder first if needed. Rejects binary files. |
| `list_allowed_folders` | Shows the folders already allowed in this session. |

`path` may be absolute or relative to the MCP server’s working directory.

## Access model

- The server starts with **no** allowed folders.
- The first access to a folder opens a native dialog with the exact action, file
  path, and folder that would be remembered.
- The dialog offers:
  - **Allow for session** — grants the folder and all subfolders until the
    server process stops.
  - **Allow once** — grants only this request.
  - **Deny** — blocks the request.
- Session grants are kept in memory only. Restarting the server forgets them.
- Symlinks are resolved before the access check. A symlink that points outside
  an allowed folder triggers a new confirmation for its real target.
- The server is read-only: it has no write, delete, rename, or execute tools.

### Dialog defaults

- Windows: the default button is **Deny**.
- macOS: the default button and the cancel action are **Deny**.
- Linux/zenity: **Deny** is selected by default.
- Linux/kdialog: the server asks twice (`Allow access?`, then `Remember for the
  session?`) with **No** as the default.

## Environment variables

| Variable | Default | Meaning |
|---|---|---|
| `MCP_FOLDER_DIALOG_TIMEOUT_MS` | `300000` | How long to wait for the user to answer a dialog |
| `MCP_FOLDER_MAX_ENTRIES` | `1000` | Maximum entries returned by `list_folder` |
| `MCP_FOLDER_MAX_READ_BYTES` | `1000000` | Maximum bytes read from a file before truncation |
| `MCP_FOLDER_HTTP_PORT` | `3921` | HTTP mode port on `127.0.0.1` |
| `MCP_FOLDER_CORS_ORIGIN` | localhost/127.0.0.1 and `*.chat-ai.academiccloud.de` | Comma-separated allowed origins for HTTP mode; supports `*` and `*.domain` wildcards |

## Security notes

- The browser/client cannot grant access. Only the native dialog can.
- Do not run the server with a pre-approved folder list; the whole point is the
  per-folder confirmation.
- A malicious MCP client can spam confirmation dialogs. Stop the server if that
  happens.
- File contents are returned to the MCP client. Only connect clients you trust.
- The server is not a sandbox. It relies on the user reading the dialog and
  choosing correctly.
- The stdio mode has no network listener. The HTTP mode binds to `127.0.0.1`
  only and accepts local origins by default.
- The HTTP endpoint is stateful per server process: all HTTP clients share the
  same session grants. Run a separate process for isolation.

## Tests

From the repository root:

```bash
npm test
```

The tests use a fake dialog and temporary folders; they do not open native
windows.
