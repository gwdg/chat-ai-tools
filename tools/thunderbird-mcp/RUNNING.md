# Running thunderbird-mcp

Short guide. Full details are in [README.md](README.md).

## 1. Build and load the extension

```bash
cd /absolute/path/to/thunderbird-mcp
npm install
npm run build
```

In Thunderbird, load `thunderbird-extension/manifest.json` as a temporary add-on
(**Tools → Developer Tools → Debug Add-ons → Load Temporary Add-on**). The
extension is required for every mail operation and is removed when Thunderbird
closes.

## 2. Choose your Thunderbird profile

The server auto-detects profiles, or you can point at one explicitly:

```bash
node dist/index.js --profile ~/.thunderbird/xxxxxxxx.default-release
```

The profile directory is the one containing `prefs.js`. If the path contains
spaces, quote it.

## 3. Run it

### stdio (used by opencode and other local MCP clients)

```bash
node dist/index.js
```

Stdio mode has no transport authentication. Any local process that can start
the server can use its tools. The `--password` options only configure the
default HTTP bearer token.

### Local HTTP endpoint

```bash
node dist/index.js --http --port 8765
```

- MCP: `POST http://127.0.0.1:8765/mcp`
- Health: `GET http://127.0.0.1:8765/health`
- Transport auth is required: send `Authorization: Bearer <token>` on every
  request. The token defaults to the HTTP bearer password (`Zinnober` unless
  changed); override it with `--token` or `THUNDERBIRD_MCP_TOKEN`.
- Browser clients from localhost/127.0.0.1 and `*.chat-ai.academiccloud.de` are
  allowed by default. For another origin, set `--cors-origin` or
  `THUNDERBIRD_MCP_CORS_ORIGIN`; patterns support `*` and `*.domain` wildcards.
- Chat AI needs the Authorization header above. An HTTPS-hosted Chat AI page may
  block the local HTTP MCP endpoint as mixed content.

## 4. Access and action confirmation

The first metadata or mail read opens a native access dialog: one approval for
account/folder metadata, then one per mailbox for `list_emails`, `read_email`,
and each mailbox searched by `search_emails`. Creating a draft, marking a
message read or unread,
changing its priority, and marking a message answered each open a separate
native confirmation dialog. Choose **Allow for session**, **Allow once**, or
**Deny**. Session approvals last until the server stops and are listed by
`list_session_approvals`.

## 5. Read-only mode

To let clients read mail but make writing impossible:

```bash
node dist/index.js --read-only
```

This removes `create_draft`, `set_email_read`, and `set_email_answered` entirely.
Without `--read-only`, drafts and flags go through the running Thunderbird
extension.

## 5b. Debugging

Add `--debug` (or set `THUNDERBIRD_MCP_DEBUG=1`) to log every tool call with
its arguments and full error stacks to stderr:

```bash
node dist/index.js --debug
```

Errors are always logged to stderr. With `--debug`, error stacks are also
included in the error text returned to the MCP client.

## 6. Use it from opencode

Add this under `mcp.servers` in `~/.config/opencode/opencode.json`:

```json
"thunderbird": {
  "type": "local",
  "command": ["node", "/home/opencode/code/thunderbird-mcp/dist/index.js"]
}
```

Add `"--read-only"` to the `command` array if you do not want draft creation.
Restart opencode after changing the config.

For HTTP instead:

```json
"thunderbird": {
  "type": "remote",
  "url": "http://127.0.0.1:8765/mcp",
  "headers": { "Authorization": "Bearer Zinnober" }
}
```

## 7. Quick check

```bash
npm test
```

To verify the profile is visible, call `list_profiles` from your MCP client, or
run the server and check `GET /health` in HTTP mode.
