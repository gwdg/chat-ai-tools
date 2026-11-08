# Browser MCP server

A local MCP server that gives an assistant a headless Chrome browser. It can
open web pages, read their text and links, list interactive elements, click,
type, press keys, scroll, wait for content, run JavaScript in the page, take
screenshots, and manage tabs.

The server drives the Chrome or Chromium already installed on the machine
through [`puppeteer-core`](https://github.com/puppeteer/puppeteer). It never
downloads a browser and never exposes the browser directly on the network.

## Requirements

- Node.js 20 or newer.
- Google Chrome, Chromium, or Microsoft Edge.
- `npm install` in this folder (installs `puppeteer-core` only).

If Chrome is not in a standard location, set `BROWSER_MCP_CHROME_PATH` to the
executable. On Linux/containers where the Chrome sandbox cannot create
namespaces, the server retries once with `--no-sandbox` and prints a warning.
You can force that up front with `BROWSER_MCP_NO_SANDBOX=1`, but prefer a
sandbox-capable environment.

## Install and run

```bash
cd tools/browser-mcp
npm install

# HTTP mode (for URL-based clients such as Chat AI)
npm start

# stdio mode (for clients that spawn the process)
npm run stdio
```

HTTP mode binds to `127.0.0.1` only and prints:

```
browser-mcp HTTP server listening on 127.0.0.1:3922
Use the following MCP endpoint in Chat AI:
http://127.0.0.1:3922/mcp
```

From the repository root the same modes are available as:

```bash
npm run mcp:browser       # HTTP
npm run mcp:browser:http  # HTTP
npm run mcp:browser:stdio # stdio
```

The browser starts lazily on the first `browser_open` call, so the MCP server
starts instantly.

### Human-like browsing

Humanization is enabled by default. Each new tab gets a normal Chrome user agent
(no `HeadlessChrome`), the system locale and timezone, an `Accept-Language`
header, and a `navigator.webdriver` override. Clicks move the mouse along a
slightly curved path with pauses, typing uses per-character delays with
occasional longer pauses, and scrolling uses mouse-wheel steps instead of
instant jumps.

Set `BROWSER_MCP_HUMANIZE=0` to disable all of it, or use
`BROWSER_MCP_USER_AGENT`, `BROWSER_MCP_LOCALE`, and `BROWSER_MCP_TIMEZONE` to
override the environment individually. This is best-effort fingerprint
reduction, not a CAPTCHA solver, and some sites still detect headless Chrome.

### Authentication

HTTP mode has no authentication by default and relies on the loopback bind. To
require a Bearer token, set `MCP_BROWSER_TOKEN`:

```bash
MCP_BROWSER_TOKEN="$(openssl rand -hex 32)" npm start
```

Clients must then send `Authorization: Bearer <token>` on every `/mcp` request.
`/health` and CORS preflight (`OPTIONS`) stay unauthenticated, and token
comparison is constant-time. stdio mode is not affected.

### Multiple chats and sessions

In HTTP mode every `initialize` request receives its own `Mcp-Session-Id` in the
response. All sessions share one Chrome process, but each gets an isolated
browser context, so tabs, cookies, `localStorage`, and the active tab are
separate per chat. A session is discarded on `DELETE`, after the idle timeout,
or when the session cap evicts the least recently used one.

Clients that ignore `Mcp-Session-Id` fall back to a single shared default
session, which is the old behavior. stdio mode has exactly one client and
therefore one session.

Set `BROWSER_MCP_USER_DATA_DIR` to keep cookies and logins across restarts. In
that mode sessions still get separate tabs, but they share the persistent
profile's cookies and storage instead of isolated contexts.

### Make targets

A `Makefile` wraps the common operations from this folder:

```bash
make            # install deps if needed, then run HTTP in the foreground
make start      # same as make
make stop       # stop the pidfile process or anything on PORT
make restart    # stop, then start
make status     # show pidfile and /health
make install    # install puppeteer-core
make test       # run the browser MCP test suite
make stdio      # run the stdio transport in the foreground
make clean      # remove the pidfile
```

Options are passed as variables:

```bash
make start PORT=3930 CHROME=/usr/bin/chromium
make start ALLOWED_HOSTS=example.com,wikipedia.org
make start USER_DATA_DIR="$HOME/.browser-mcp-profile"
make start NO_SANDBOX=1
make start CORS_ORIGIN=http://localhost:8080
make start SESSION_IDLE=600000 MAX_SESSIONS=8
make start HUMANIZE=0
make start TOKEN="$(openssl rand -hex 32)"
```

`make stop` falls back to `lsof`, `fuser`, and `pgrep` when no pidfile exists.

## Tools

| Tool | What it does |
|---|---|
| `browser_open` | Open an absolute `http(s)` URL and return title, URL, tab id, and visible text |
| `browser_read` | Read page text or HTML, optionally from one CSS selector, with links |
| `browser_snapshot` | List interactive elements (links, buttons, inputs, selects) with stable ids |
| `browser_click` | Click by snapshot id, CSS selector, or visible text |
| `browser_type` | Focus a field, replace its contents, type text, optionally submit with Enter |
| `browser_press` | Press a key such as `Enter`, `Tab`, `Escape`, `ArrowDown` |
| `browser_scroll` | Scroll up/down, jump to top/bottom, or bring an element into view |
| `browser_wait_for` | Wait for a selector state or for page text to appear |
| `browser_evaluate` | Evaluate a JavaScript expression in the page and return JSON |
| `browser_screenshot` | Capture the viewport or full page as PNG/JPEG |
| `browser_tabs` | List open tabs |
| `browser_switch_tab` | Change the active tab |
| `browser_close_tab` | Close one tab |
| `browser_history` | Go back, go forward, or reload |
| `browser_close` | Close the browser and all tabs |

Typical loop:

1. `browser_open` with a URL.
2. `browser_snapshot` to see what can be clicked or filled.
3. `browser_click` with an `id`, `selector`, or visible `text`.
4. `browser_type` to fill a field and `submit: true` to press Enter.
5. `browser_read` or `browser_screenshot` to inspect the result.

Snapshot ids are only valid until the next `browser_snapshot` call; each
snapshot renumbers the elements on the current page.

## Configuration

| Variable | Meaning |
|---|---|
| `MCP_BROWSER_HTTP_PORT` | HTTP mode port (default `3922`) |
| `HOST` | Loopback bind address: `127.0.0.1`, `localhost`, or `::1` only |
| `MCP_BROWSER_TOKEN` | Require this Bearer token on `/mcp` (default: no authentication) |
| `MCP_BROWSER_CORS_ORIGIN` | Comma-separated allowed browser origins; defaults to localhost/127.0.0.1 |
| `MCP_BROWSER_SESSION_IDLE_MS` | Idle timeout before a session is closed (default `1800000`, `0` disables expiry) |
| `MCP_BROWSER_MAX_SESSIONS` | Maximum concurrent sessions before the oldest is evicted (default `20`) |
| `MCP_BROWSER_TRANSPORT` | Set to `http` to start HTTP mode without `--http` |
| `BROWSER_MCP_CHROME_PATH` | Path to the Chrome/Chromium/Edge executable |
| `BROWSER_MCP_HUMANIZE` | `0` disables human-like UA, locale, and input timing (default on) |
| `BROWSER_MCP_USER_AGENT` | Override the generated Chrome user agent |
| `BROWSER_MCP_LOCALE` | Override the locale used for `navigator.language` and `Accept-Language` |
| `BROWSER_MCP_TIMEZONE` | Override the IANA timezone, for example `Europe/Berlin` |
| `BROWSER_MCP_USER_DATA_DIR` | Persistent Chrome profile directory (keeps cookies/logins) |
| `BROWSER_MCP_NO_SANDBOX` | `1` to launch Chrome with `--no-sandbox` |
| `BROWSER_MCP_ALLOWED_HOSTS` | Comma-separated host allowlist, for example `example.com,intranet.test` |
| `BROWSER_MCP_TIMEOUT_MS` | Default navigation/tool timeout (default `30000`) |
| `BROWSER_MCP_MAX_CHARS` | Upper bound for returned text (default `200000`) |

## Security notes

- The MCP server listens on loopback only. A non-loopback `HOST` is refused.
- Only `http` and `https` navigation is allowed. `file:`, `javascript:`,
  `data:`, and other schemes are rejected before Chrome sees them.
- `BROWSER_MCP_ALLOWED_HOSTS` restricts navigation to named hosts and their
  subdomains, including redirects and links clicked inside the page. Leave it
  unset only when unrestricted web access is intended.
- `browser_evaluate` runs arbitrary JavaScript **in the page**, not in Node. It
  cannot read local files or environment variables directly, but it can call
  APIs available to the page.
- The tool can reach websites and local network services that the machine can
  reach. Do not expose the HTTP endpoint to other machines.
- The browser profile is temporary unless `BROWSER_MCP_USER_DATA_DIR` is set.
  That directory can contain cookies and sessions; keep it private.
- Page dialogs (`alert`, `confirm`, `prompt`) are accepted automatically so they
  do not block automation.

## Tests

The repository test suite covers URL policy, the MCP protocol, HTTP transport,
and an optional end-to-end run against a real headless Chrome:

```bash
npm test
```

The end-to-end test is skipped automatically when `puppeteer-core` or Chrome is
not available.
