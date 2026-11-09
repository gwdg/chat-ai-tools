# Chromium MCP browser control

A Chromium extension plus a local MCP relay that lets Chat AI control the
browser you are already using. The extension shows a confirmation window for
every tab it is asked to access. You can allow once, allow for the rest of the
browser session, or deny.

```
MCP client (Chat AI) -- HTTP /mcp --> chromium-mcp relay
                                         ^
                                         | WebSocket
                                         |
                              Chromium extension -- chrome.* APIs --> tabs
```

The relay is local-only. The extension connects out to it; nothing is exposed to
the internet.

## Requirements

- Node.js 20 or newer.
- Chromium, Google Chrome, or Microsoft Edge version 116 or newer.
- The extension loaded from `tools/chromium-mcp/extension/`.

## Start the relay

```bash
cd tools/chromium-mcp
npm install
npm start
# or from the repository root:
npm run mcp:chromium
```

It prints:

```text
chromium-mcp HTTP server listening on 127.0.0.1:8766
Use the following MCP endpoint in Chat AI:
http://127.0.0.1:8766/mcp
Extension WebSocket:
ws://127.0.0.1:8766/extension
```

For MCP clients that spawn a child process, use `npm run stdio` in this folder or
`npm run mcp:chromium:stdio` from the repository root. In stdio mode the
extension still connects over the WebSocket port (default `8766`).

### Make targets

A Makefile runs the relay and extension port from this folder:

```bash
make            # install deps if needed, then run HTTP + WebSocket
make start      # same as make
make stop       # stop the pidfile process or anything on PORT
make restart    # stop, then start
make status     # show pidfile and /health
make install    # install the ws dependency
make test       # run the chromium-mcp tests
make stdio      # run the MCP relay over stdio (extension still uses PORT)
make clean      # remove the pidfile
```

Options:

```bash
make start PORT=9000
make start HOST=::1
make start MCP_TOKEN=secret EXTENSION_TOKEN=ext-secret
make start CORS_ORIGIN=http://localhost:8080
make start COMMAND_TIMEOUT=300000
```

After starting, the extension connects to `ws://127.0.0.1:8766/extension`
(or the configured port).

## Load and connect the extension

1. Open `chrome://extensions` (or `edge://extensions`).
2. Enable **Developer mode**.
3. Choose **Load unpacked** and select:
   `tools/chromium-mcp/extension/`
4. Open the extension's **Options** page.
5. Keep the default relay URL `ws://127.0.0.1:8766/extension`, or change it to
   match the relay, then choose **Save and connect**.
6. The toolbar popup shows **Connected**. The badge shows `ON`.

If the relay sets `MCP_CHROMIUM_EXTENSION_TOKEN`, enter the same token on the
options page. This token is separate from the MCP bearer token.

## Use it in Chat AI

Add a remote MCP server:

```json
{
  "type": "remote",
  "url": "http://127.0.0.1:8766/mcp"
}
```

If `MCP_CHROMIUM_TOKEN` is set on the relay, add:

```json
{
  "headers": { "Authorization": "Bearer <token>" }
}
```

Use a Chat AI instance served over HTTP on localhost. An HTTPS page may block the
local HTTP MCP endpoint as mixed content.

## Confirmation model

Every tool that reads or controls a tab asks the user first. The confirmation
window shows the purpose, tab title, site origin, and URL, with three choices:

- **Allow once** — applies only to the current request.
- **Allow for session** — grants this tab and site until the browser closes.
  Grants are kept in `chrome.storage.session`, are never written to disk, and
  can be revoked from the toolbar popup.
- **Deny** — the tool call fails and nothing is read or changed.

Grants are keyed by tab id **and origin**. If the tab navigates to another site,
a new confirmation is required even if the tab was previously approved.

`browser_tabs` does not reveal titles or URLs for tabs that are not approved. It
shows only the tab id and whether the tab is active or restricted. This means the
assistant must request access to a tab before it can see what the tab contains.

Restricted pages (`chrome://`, `edge://`, `about:`, `file:`, and other non-http
schemes) cannot be controlled.

## Tools

| Tool | What it does |
|---|---|
| `browser_status` | Check whether the extension is connected |
| `browser_tabs` | List tabs (details only for approved tabs) |
| `browser_open` | Open a URL in a new tab or navigate an existing one |
| `browser_read` | Read text or HTML, optionally from a selector |
| `browser_snapshot` | List interactive elements with stable ids |
| `browser_click` | Click by snapshot id, selector, or visible text |
| `browser_type` | Fill a field and optionally submit with Enter |
| `browser_press` | Send a key to the focused element |
| `browser_scroll` | Scroll or bring an element into view |
| `browser_wait_for` | Wait for a selector or page text |
| `browser_evaluate` | Evaluate JavaScript in the page |
| `browser_screenshot` | Capture the visible tab as PNG/JPEG |
| `browser_activate_tab` | Switch to a tab |
| `browser_close_tab` | Close a tab |
| `browser_history` | Go back, forward, or reload |

Actions use the page's DOM, not trusted OS-level input. Some sites may ignore
synthetic key events. `browser_evaluate` can be blocked by a page's Content
Security Policy. Screenshots capture the visible viewport, not the full page.

## Configuration

| Variable | Meaning |
|---|---|
| `MCP_CHROMIUM_HTTP_PORT` | HTTP/WebSocket port (default `8766`) |
| `MCP_CHROMIUM_EXTENSION_PORT` | WebSocket-only port in stdio mode (default `8766`) |
| `HOST` | Loopback bind address: `127.0.0.1`, `localhost`, or `::1` only |
| `MCP_CHROMIUM_CORS_ORIGIN` | Comma-separated allowed browser origins; supports `*` and `*.domain` wildcards (default: localhost/127.0.0.1 and `*.chat-ai.academiccloud.de`) |
| `MCP_CHROMIUM_TOKEN` | Require this Bearer token on `/mcp` (default: no authentication) |
| `MCP_CHROMIUM_EXTENSION_TOKEN` | Require this token in the extension hello message |
| `MCP_CHROMIUM_COMMAND_TIMEOUT_MS` | Browser command timeout (default `180000`) |
| `MCP_CHROMIUM_TRANSPORT` | Set to `http` to start HTTP mode without `--http` |

## Security notes

- The relay binds to `127.0.0.1` only and refuses a non-loopback `HOST`.
- WebSocket connections must come from a `chrome-extension://` origin. A local
  non-browser client that omits the origin is accepted only when
  `MCP_CHROMIUM_EXTENSION_TOKEN` is set and the token matches.
- Set `MCP_CHROMIUM_TOKEN` if other local users or processes can reach localhost.
- Only one browser extension is active at a time. A newer connection replaces the
  older one.
- Grants are browser-wide, not per Chat AI conversation. A tab approved for the
  session can be used by any MCP client connected to the same relay until the
  browser closes or the grants are revoked.
- Treat page content and model output as untrusted. The extension does not read
  local files or Chrome-internal pages.

## Troubleshooting disconnects

Chrome can suspend Manifest V3 service workers when they are idle. This version
sends an application-level heartbeat from the relay every 20 seconds and runs a
one-minute `chrome.alarms` reconnect check, so brief reconnects should recover on
their own.

The relay now logs close codes:

- `4401` — the extension token was rejected. Fix the token in the options page.
- `4408` — the extension did not send its hello in time.
- `4409` — another browser/extension connection replaced this one.
- `1006` / other — the socket dropped. The extension reconnects automatically.

If disconnects persist:

1. Confirm the relay is still running: `make status` or
   `curl http://127.0.0.1:8766/health`.
2. Check the relay console for the close code.
3. Open `chrome://extensions`, find the extension, and inspect its service worker
   console for `[chromium-mcp]` messages.
4. Do not keep two browsers or two extension instances connected at the same
   time; the newest connection replaces the older one.
5. Use Chromium/Chrome 116 or newer.

## Tests

```bash
cd tools/chromium-mcp
npm test
```

The tests cover URL and grant-key logic, MCP tool routing, WebSocket origin and
token checks, bearer authentication, and error handling. Loading the extension
and clicking the confirmation window require a normal browser session and are
not covered by the automated tests.

## Packaging

Package the extension on Linux:

```bash
make -C build/linux        # Web Store ZIP
make -C build/linux crx    # signed CRX
```

See [build/linux/chromium-mcp/README.md](../../build/linux/chromium-mcp/README.md).

For the Windows relay executable and NSIS installer, see
[build/windows/chromium-mcp/README.md](../../build/windows/chromium-mcp/README.md).
The installer places the unpacked extension next to the relay; load it with
**Load unpacked**.
