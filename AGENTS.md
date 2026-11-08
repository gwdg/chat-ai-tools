# AGENTS.md

Guidance for AI coding agents working in `chat-ai-tools`.

## What this repository is

Reusable, dependency-free tools for using Chat AI / SAIA in other solutions.

The repository currently contains:

- a framework-agnostic client for OpenAI-compatible chat endpoints,
- a `<chat-ai-widget>` custom element for embedding a chatbot in a webpage,
- a minimal Node proxy that keeps the API key on the server,
- a static example page with a predefined SAIA configuration,
- tests for the client logic.

There is no build step, no bundler, and no runtime dependency. The code targets
modern browsers and Node.js 18 or newer.

## Layout

```
chat-ai-tools/
├── src/
│   ├── chat-ai-client.js      OpenAI-compatible client, streaming + JSON
│   └── chat-ai-widget.js      <chat-ai-widget> custom element
├── examples/
│   ├── embedded-chatbot/      Example page + predefined configuration
│   ├── popup-chatbot/         Popup/launcher example
│   └── proxy/
│       ├── server.mjs         Minimal server-side proxy for Chat AI / SAIA
│       └── request-policy.mjs Builds the backend-enforced chat request
├── tools/local-folder-mcp/    Read-only local folder MCP server + native dialogs
├── tools/thunderbird-mcp/     Thunderbird MCP server + privileged extension
├── tools/crm-mcp/             Local-first CRM MCP server backed by SQLite
├── tools/browser-mcp/         Headless Chrome MCP server (puppeteer-core)
├── assets/eu-ai-icons/        Official EU fully AI-generated badge (black/white)
├── scripts/serve.mjs          Static server for local development
├── tests/                     node:test suites
├── secrets/
│   └── back.json.example      Proxy configuration template
├── package.json
├── README.md
└── AGENTS.md
```

## Architecture

Recommended flow for a public webpage:

```
browser page → <chat-ai-widget> → local/deployed proxy → SAIA
```

- The widget talks to an OpenAI-compatible endpoint and can render inline or as a
  fixed popup launcher.
- The proxy holds the long-lived SAIA API key and forwards only the model list
  and chat completion requests.
- The proxy builds the final request from `secrets/back.json`: model, system
  prompt, sampling values, and limits. A client cannot override them.
- The browser never receives the API key.

Direct browser-to-SAIA calls are possible with a short-lived user token, but
CORS may block them and any token in browser code is visible to visitors.
Prefer the proxy.

## API contract

The client uses the OpenAI-compatible endpoints:

- `GET  <base>/models`
- `POST <base>/chat/completions`

`<base>` usually ends in `/v1`, for example
`https://chat-ai.academiccloud.de/v1`.

Request fields used by the client:

```json
{
  "model": "...",
  "messages": [{ "role": "system|user|assistant", "content": "..." }],
  "temperature": 0.5,
  "top_p": 0.8,
  "max_tokens": 1024,
  "stream": true
}
```

The client may send its own model, system prompt, sampling values, and tools, but
the included proxy ignores them. `prepareChatRequest()` in
`examples/proxy/request-policy.mjs` rebuilds the request:

- it drops all client `system`, `developer`, and `tool` messages,
- it keeps only `user` and `assistant` text messages,
- it prepends the `systemPrompt` from `back.json`,
- it pins `model`, `temperature`, `top_p`, and `max_tokens` from `back.json`,
- it drops tools and unknown fields,
- it limits history to `maxMessages` and input to `maxInputChars`.

Do not move this policy back into the client. The browser is not a trust
boundary. If the proxy is bypassed (for example by pointing the widget directly
at the Chat AI back service), the backend prompt is not enforced.

Streaming responses use server-sent events: `data: {json}` lines terminated by a
blank line, ending with `data: [DONE]`. The client yields the text deltas.

If a `token` is configured, the client sends `Authorization: Bearer <token>`.
It also sends `inference-portal: <serviceName>` when `serviceName` is set. The
proxy injects the real `Authorization` header and ignores a client-supplied one.

**SAIA quirk:** `/models` can answer with HTTP 200 and an error body such as
`{"message":"Unauthorized"}`. `ChatAIClient.listModels()` treats that as an
error instead of returning an empty list. Keep this behavior; do not trust the
status code alone.

## Security invariants

- Never commit `secrets/back.json` or any real key. Only
  `secrets/back.json.example` belongs in the repository.
- Public pages must not contain long-lived API keys. Use the proxy.
- A `token` in browser code is visible to every visitor; use only short-lived,
  per-user tokens for direct mode.
- Treat model output as untrusted. The widget writes it with `textContent` and
  must not switch to `innerHTML` for model output.
- Every embedded chatbot must show an AI disclosure above the conversation and
  a **Data privacy** link next to the EU AI-generated badge. The link opens the
  full statement in a dialog inside the widget. Configuring the texts is allowed
  for localization or organization-specific wording, but the defaults must not
  be removed silently. The AI notice must clearly say that the user is talking
  to an AI assistant; the privacy statement must explain where messages are
  processed and warn against entering personal or confidential data. Render
  `privacyDetails` as plain text, never as HTML.
- Use the official EU “fully AI-generated” badge next to the assistant title.
  Keep the black variant for light mode and the white variant for dark mode, and
  keep the alt text (`aiIconAlt`). Do not replace it with a custom badge. The
  source and licence note are in `assets/eu-ai-icons/README.md`. The badge does
  not by itself establish AI Act compliance.
- In popup mode the launcher must be keyboard accessible, have a visible focus
  state, an `aria-label`, and `aria-expanded`. Opening and minimizing must not
  drop the conversation. The panel must keep the AI disclosure, EU badge, and
  Data privacy link.
- Keep the system prompt in `secrets/back.json`, not in browser code. The proxy
  must drop client system/developer messages and rebuild the request. Never log
  the system prompt or message content.
- The proxy forwards only `/models` and `/chat/completions` (plus their `/v1`
  aliases) and `/health`. Do not turn it into an open forward proxy.
- The proxy and development server bind to loopback only (`127.0.0.1` or
  `::1`). Refuse non-loopback `HOST` values; do not add a `0.0.0.0` option.
- CORS defaults to localhost/127.0.0.1 origins. `CORS_ORIGIN=*` lets any website
  call the local proxy and must not be used without an explicit reason.
- Do not log message content, request bodies, or API keys. The proxy logs only
  method, path, status, and duration.
- Add authentication, rate limiting, and request-size limits before exposing the
  proxy on the public internet.

## MCP servers

`tools/local-folder-mcp/` is an MCP server with stdio and local HTTP transports. Its invariants:

- **Local transports only.** Use stdio for clients that spawn a child process,
  or Streamable HTTP bound to `127.0.0.1` for URL-based clients such as Chat AI.
  Never bind `0.0.0.0` and never add a public listener.
- **stdout is protocol only in stdio mode.** Write JSON-RPC to stdout and logs
  to stderr. Any debug `console.log` breaks the client connection.
- **HTTP mode prints its endpoint.** On startup it prints the IP, port, and
  `Use the following MCP endpoint in Chat AI:` followed by
  `http://127.0.0.1:<port>/mcp`. Keep that output stable.
- **HTTP CORS is local by default.** Accept localhost/127.0.0.1 origins; allow
  `MCP_FOLDER_CORS_ORIGIN` overrides only for a specific local origin.
- **Read-only.** Do not add write, delete, rename, or execute tools without a
  separate design and explicit approval.
- **Native confirmation for every new folder.** Do not add an auto-allow env,
  flag, or default. The dialog is the authorization boundary.
- **Session-only grants.** Allowed folders live in process memory and disappear
  on restart. Do not persist them.
- **Resolve real paths.** Use `realpath`; check containment against granted roots
  with `path.relative` (not a string prefix). Symlinks that escape a granted root
  must trigger a new confirmation.
- **Default to deny.** Windows/macOS use Deny as the default button; Linux
  dialogs default to Deny/No.
- **Show all three options without scrolling.** Keep the message area scrollable
  and the action buttons fixed. Do not shrink the dialog so that "Allow for
  session", "Allow once", or "Deny" fall below the visible area.
- **Platform support:** Windows PowerShell/WinForms, macOS `osascript`, Linux
  `zenity` or `kdialog`. If no dialog is available, fail closed with a clear
  error.
- Tests must use a fake dialog and temporary folders; CI must not open native
  windows. Keep `npm test` green.

When changing the server, update `tools/local-folder-mcp/README.md` and the
root README.

`tools/browser-mcp/` is a local headless-browser MCP server with stdio and
local HTTP transports. Its invariants:

- **Local transports only.** HTTP mode binds to `127.0.0.1` and refuses any
  non-loopback `HOST`. Never add a public listener.
- **stdout is protocol only in stdio mode.** Write JSON-RPC to stdout and logs
  to stderr.
- **HTTP mode prints its endpoint.** It prints the same
  `Use the following MCP endpoint in Chat AI:` block followed by
  `http://127.0.0.1:<port>/mcp`. Keep that output stable.
- **HTTP CORS is local by default.** Accept localhost/127.0.0.1 origins; allow
  `MCP_BROWSER_CORS_ORIGIN` overrides only for a specific local origin.
- **Optional bearer authentication.** No token is required by default. When
  `MCP_BROWSER_TOKEN` is set, every `/mcp` request must send
  `Authorization: Bearer <token>`; compare in constant time. Keep `/health` and
  CORS preflight (`OPTIONS`) unauthenticated. Never log the token.
- **Navigation is http(s) only.** `file:`, `javascript:`, `data:`, and other
  schemes are rejected before Chrome sees them. Keep
  `BROWSER_MCP_ALLOWED_HOSTS` as an optional host allowlist.
- **No browser download.** Use `puppeteer-core` with an installed Chrome,
  Chromium, or Edge executable. `BROWSER_MCP_CHROME_PATH` selects it.
- **Sandbox first.** Launch with the sandbox when the platform supports it.
  Only retry with `--no-sandbox` on Linux after a sandbox/namespace failure, and
  print a warning. `BROWSER_MCP_NO_SANDBOX=1` is an explicit opt-out.
- **Page context only.** `browser_evaluate` runs JavaScript in the page, never
  in Node. Do not expose Node APIs, files, or environment variables to it.
- **Human-like by default, no CAPTCHA bypass.** Tabs use a non-headless Chrome
  user agent, system locale/timezone, `Accept-Language`, a `navigator.webdriver`
  override, curved mouse movement, per-character typing delays, and wheel
  scrolling. `BROWSER_MCP_HUMANIZE=0` disables this. Do not add CAPTCHA solving
  or claim that it defeats anti-bot systems.
- **Per-chat sessions.** HTTP mode assigns a `Mcp-Session-Id` on initialize and
  keeps separate browser contexts, tabs, and active-tab state per session. One
  session must never reach another session's tabs. Only clients that omit the
  header share a single fallback session. Sessions expire after the idle
  timeout and are capped by `MCP_BROWSER_MAX_SESSIONS`.
- **Temporary profile by default.** Only persist cookies and sessions when
  `BROWSER_MCP_USER_DATA_DIR` is set; document that it is sensitive. With a
  persistent profile, sessions still use separate tabs but share the profile's
  cookies and storage.
- Tests must not require Chrome on machines without it; the end-to-end test
  skips when `puppeteer-core` or Chrome is unavailable.
- When changing the server, update `tools/browser-mcp/README.md` and the root
  README.

## Windows packaging

Every packaged tool has its own subfolder under `build/windows/<tool>/`. New
tools must provide a Windows build that can be produced on Linux; see
[Adding a tool or example](#adding-a-tool-or-example). `build/windows/Makefile`
builds every package the current host supports; `make -C build/windows` runs the
`browser` and `thunderbird` cross-builds and skips `local-folder` outside
Windows.

The local folder MCP server can be built as a standalone Windows executable and
an Inno Setup installer.

- Build files live in `build/windows/local-folder-mcp/`.
- `npm run build:windows` bundles the server with esbuild and creates a Node SEA
  executable. Run it on Windows; it copies the running `node.exe`, so it cannot
  cross-build a Windows executable from Linux or macOS.
- The SEA bundle sets `MCP_SEA=1` through an esbuild banner. The bottom of
  `server.mjs` calls `main()` when that variable is set. Do not remove this guard
  or the bundle will fail to start.
- `build/windows/local-folder-mcp/installer.iss` creates a per-user installer
  in `%LOCALAPPDATA%` and a Start Menu shortcut that runs `--http`. Keep it
  `PrivilegesRequired=lowest`; there is no machine-wide install.
- `esbuild` and `postject` are build-only dev dependencies. The emitted
  executable has no runtime dependencies; Windows PowerShell provides the native
  dialogs.
- `.github/workflows/build-windows-installer.yml` builds the tests, executable,
  and installer on `windows-latest` and uploads the artifacts. Run it with
  `workflow_dispatch`.
- Do not commit `node_modules/` or `build/windows/local-folder-mcp/out/`.
- The executable and installer are unsigned by default. Sign them with an
  organization certificate before broad distribution to avoid SmartScreen.
- Keep `build/windows/local-folder-mcp/installer-readme.txt` in sync with the
  actual endpoint output and access model.

The browser MCP server has a separate Linux cross-build under
`build/windows/browser-mcp/`:

- `build-installer.sh` downloads matching Linux and Windows Node.js runtimes,
  verifies their checksums, bundles `server.mjs` plus `puppeteer-core` with
  esbuild, creates the SEA blob with the matching Linux Node.js binary, injects
  it into the Windows `node.exe` with `postject`, and compiles the NSIS
  installer with `makensis`.
- The esbuild banner sets `MCP_SEA=1`. Keep the
  `if (process.env.MCP_SEA === "1") main();` guard at the bottom of
  `tools/browser-mcp/server.mjs`.
- `npm run build:browser:windows` runs the script. `ZIP_ONLY=1` skips NSIS and
  builds only the portable ZIP; `SKIP_TESTS=1` skips the pre-build tests.
- Outputs are `browser-mcp.exe`, `browser-mcp-setup.exe`,
  `browser-mcp-windows.zip`, and `SHA256SUMS.txt` in
  `build/windows/browser-mcp/out/`. Do not commit `out/` or `.cache/`.
- `makensis` (NSIS) is required for the installer. The artifacts are unsigned,
  and Chrome/Chromium/Edge is not bundled; the target machine must provide it.
- Keep `build/windows/browser-mcp/installer.nsi` and `installer-readme.txt` in
  sync with the endpoint, authentication, and browser requirements.

The Thunderbird MCP server has a Linux cross-build under
`build/windows/thunderbird-mcp/`:

- `build-installer.sh` builds the TypeScript server, downloads matching Linux
  and Windows Node.js runtimes, bundles `dist/index.js` with esbuild, creates the
  SEA blob with the Linux binary, injects it into the Windows `node.exe` with
  `postject`, packages the extension as an XPI and unpacked folder, and compiles
  the NSIS installer with `makensis`.
- The installer adds a launcher that generates a random Bearer token on first
  run and stores it in `token.txt`; do not replace it with a shared default
  password.
- Windows profile detection must include `%APPDATA%\Thunderbird`. Keep
  `profileBaseDirs()` in `tools/thunderbird-mcp/src/profile.ts` platform-aware.
- Windows uses the file bridge; the optional Unix socket transport is
  Linux/macOS-only. Do not make the file bridge require Unix sockets.
- `npm run build:thunderbird:windows` runs the script. `ZIP_ONLY=1` skips NSIS;
  `SKIP_TESTS=1` skips the pre-build tests.
- Outputs are `thunderbird-mcp.exe`, `thunderbird-mcp-setup.exe`,
  `thunderbird-mcp-extension.xpi`, `thunderbird-mcp-windows.zip`, and
  `SHA256SUMS.txt` in `build/windows/thunderbird-mcp/out/`. Do not commit
  `out/` or `.cache/`.
- The extension is privileged and must be loaded or installed in Thunderbird;
  the installer does not silently modify the Thunderbird profile.
- Keep `build/windows/thunderbird-mcp/installer.nsi` and `installer-readme.txt`
  in sync with the server options, profile detection, and extension steps.

## Adding a tool or example

Every new tool or example must be documented. A feature is not complete until:

1. Reusable code lives in `src/` or `tools/`, examples live in `examples/<name>/`.
2. The README (or a local README) explains purpose, configuration, and how to
   run it.
3. Logic has at least one test in `tests/` using `node:test`.
4. Example configuration contains no secrets.
5. `npm test` passes.
6. The example has been started with `npm run dev` / `npm run proxy` and
   exercised, not just compiled.
7. `AGENTS.md` is updated only with constraints verified in the code.
8. A new tool also includes a Windows installer that can be built on Linux,
   under `build/windows/<tool>/`, following `build/windows/browser-mcp/`. The
   cross-build downloads matching Linux and Windows Node.js runtimes, bundles
   the server with esbuild, creates a Node SEA executable with `postject`, and
   compiles an NSIS installer with `makensis`. It produces the `.exe`, the
   installer, a portable ZIP, and `SHA256SUMS.txt`. Add an npm script, document
   prerequisites and artifacts, and keep the installer readme in sync. If a tool
   cannot be packaged this way, document why in its README and in `AGENTS.md`
   instead of silently skipping it.

Do not add a dependency when a built-in browser or Node API is sufficient.

## Public API and conventions

Keep these names stable unless a breaking change is intentional:

- `ChatAIClient`, `ChatAIError`, `completionsUrl`, `modelsUrl`
- `ChatAIWidget`, the `chat-ai-widget` custom element
- Widget configuration keys: `endpoint`, `model`, `systemPrompt`,
  `temperature`, `topP`, `maxTokens`, `token`, `serviceName`, `title`,
  `aiDisclosure`, `privacyLinkLabel`, `privacyDetails`, `aiIconAlt`,
  `welcome`, `placeholder`, `height`, `popup`
- String attributes use kebab-case (`system-prompt`, `service-name`).
  Sampling values (`temperature`, `topP`, `maxTokens`) are for direct mode; the
  included proxy pins them from `back.json`.

Code style:

- Vanilla ES modules, `type: "module"`.
- No build step and no framework.
- Browser code must not use Node built-ins.
- Node code uses `node:` imports.
- Prefer `textContent` over HTML injection.
- Keep the client and widget usable without the example proxy.

## Commands

```bash
npm test            # node:test suite
npm run dev         # static server on :8080, redirects / to the example
npm run proxy       # proxy on :8081, reads secrets/back.json
npm run mcp:folder       # local folder MCP server over HTTP (prints endpoint)
npm run mcp:folder:stdio # local folder MCP server over stdio
npm run mcp:browser       # headless browser MCP server over HTTP (prints endpoint)
npm run mcp:browser:stdio # headless browser MCP server over stdio
npm run build:browser:windows # Windows exe + NSIS installer from Linux
npm run build:thunderbird:windows # Windows exe + installer + extension XPI from Linux
make -C build/windows             # build every Windows package this host supports
```

Environment overrides:

- `PORT` — port for the static server or proxy.
- `HOST` — loopback bind address. Only `127.0.0.1` and `::1` are accepted.
- `MCP_FOLDER_HTTP_PORT` — local folder MCP HTTP port (default `3921`).
- `MCP_FOLDER_CORS_ORIGIN` — comma-separated local origins for the MCP HTTP
  mode; defaults to localhost/127.0.0.1.
- `MCP_BROWSER_HTTP_PORT` — browser MCP HTTP port (default `3922`).
- `MCP_BROWSER_CORS_ORIGIN` — comma-separated local origins for the browser MCP
  HTTP mode; defaults to localhost/127.0.0.1.
- `MCP_BROWSER_TOKEN` — Bearer token required on `/mcp` when set (default: no
  authentication).
- `MCP_BROWSER_SESSION_IDLE_MS` — idle session timeout (default `1800000`; `0`
  disables expiry).
- `MCP_BROWSER_MAX_SESSIONS` — maximum concurrent sessions (default `20`).
- `BROWSER_MCP_CHROME_PATH` — Chrome/Chromium/Edge executable to drive.
- `BROWSER_MCP_HUMANIZE` — `0` disables human-like UA, locale, and input timing.
- `BROWSER_MCP_USER_AGENT` — override the generated Chrome user agent.
- `BROWSER_MCP_LOCALE` — override locale for `navigator.language` and `Accept-Language`.
- `BROWSER_MCP_TIMEZONE` — override the IANA timezone.
- `BROWSER_MCP_ALLOWED_HOSTS` — optional comma-separated host allowlist.
- `BROWSER_MCP_USER_DATA_DIR` — persistent browser profile (sensitive).
- `BROWSER_MCP_NO_SANDBOX` — `1` forces `--no-sandbox`; avoid unless required.
- `CORS_ORIGIN` — comma-separated allowed origins; defaults to localhost and
  127.0.0.1 origins.
- `CONFIG_LOCATION` — path to the proxy config (default `secrets/back.json`).

## Definition of done

- [ ] `npm test` passes.
- [ ] The example page loads through `npm run dev`.
- [ ] The proxy answers `/models` and `/chat/completions`.
- [ ] The AI disclosure is visible in the widget.
- [ ] The Data privacy link is next to the EU badge and opens the full statement
      in the dialog.
- [ ] The popup example opens and minimizes from the launcher icon and keeps its
      messages while minimized.
- [ ] The official EU fully AI-generated badge is next to the assistant title,
      visible, and has alt text.
- [ ] The backend model, system prompt, sampling values, and limits from
      `secrets/back.json` override the client request.
- [ ] The local folder MCP server remains read-only, asks for every new folder,
      and either uses stdio or binds its HTTP mode to `127.0.0.1` only.
- [ ] The browser MCP server accepts only http(s) navigation and either uses
      stdio or binds its HTTP mode to `127.0.0.1` only.
- [ ] The browser MCP HTTP endpoint requires `Authorization: Bearer` when
      `MCP_BROWSER_TOKEN` is set, and works without a token by default.
- [ ] HTTP mode prints the endpoint in the documented form.
- [ ] The proxy and development server bind to loopback only.
- [ ] Client `system`/`developer` messages and tool fields are dropped by the
      proxy.
- [ ] No secret is present in tracked files.
- [ ] Every new local tool has a Linux-buildable Windows installer under
      `build/windows/<tool>/`, or a documented reason why it cannot be packaged.
- [ ] New Windows builds are wired into `build/windows/Makefile`.
- [ ] New configuration and usage are documented in `README.md`.
- [ ] Model output is written with `textContent`, never injected as HTML.
- [ ] The change still works without the local proxy (for example against an
      existing Chat AI back service or a direct endpoint).

## Maintaining this file

Add rules only after verifying them in the repository. Keep this file to facts
and requirements, not task logs, plans, or status updates. If a rule becomes
wrong, fix it instead of working around it.
