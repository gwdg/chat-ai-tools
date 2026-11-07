# Chat AI Tools

Reusable, dependency-free tools for using **Chat AI** and **SAIA** in other
solutions.

The repository is useful when you want to add a chatbot to your own webpage,
call a SAIA endpoint from a small app, or share a predefined assistant
configuration without copying the whole Chat AI front end.

## What is included

| Path | Purpose |
|---|---|
| `src/chat-ai-client.js` | Framework-agnostic OpenAI-compatible client with streaming and non-streaming calls |
| `src/chat-ai-widget.js` | `<chat-ai-widget>` custom element: a small embeddable chat UI |
| `examples/embedded-chatbot/` | Example webpage with a predefined SAIA assistant configuration |
| `examples/popup-chatbot/` | Same widget in popup/launcher mode |
| `examples/proxy/server.mjs` | Minimal Node proxy that keeps the SAIA API key on the server |
| `tools/local-folder-mcp/` | Read-only MCP server for local folders with native access confirmation dialogs |
| `tools/thunderbird-mcp/` | Local Thunderbird MCP server + privileged extension; native mailbox access and action confirmation dialogs |
| `build/windows/` | Standalone Windows executable (Node SEA) and Inno Setup installer |
| `README-Windows.txt` | Complete Windows build, install, and troubleshooting guide |
| `assets/eu-ai-icons/` | Official EU “fully AI-generated” badge, black and white variants |
| `scripts/serve.mjs` | Static server for local development |
| `tests/` | `node:test` suites for the client logic |

No build step, no bundler, no runtime dependencies. Browser code works in modern
browsers; Node code requires Node.js 18 or newer.

## Quick start

1. Create the proxy configuration and add your SAIA API key:

   ```bash
   cp secrets/back.json.example secrets/back.json
   # edit secrets/back.json and replace <your SAIA API key>
   ```

2. Start the proxy:

   ```bash
   npm run proxy
   # http://127.0.0.1:8081 -> https://chat-ai.academiccloud.de/v1
   ```

3. Start the static server in a second terminal:

   ```bash
   npm run dev
   ```

4. Open an example:

   - Embedded: <http://127.0.0.1:8080/examples/embedded-chatbot/>
   - Popup: <http://127.0.0.1:8080/examples/popup-chatbot/>

The API key stays in `secrets/back.json`; it is never sent to the browser.

Both the proxy and the development server bind to **127.0.0.1 only**. A
non-loopback `HOST` value is refused. The MCP server uses stdio and opens no
network port at all.

## How the example works

```
browser page
  └─ <chat-ai-widget>
       └─ POST http://127.0.0.1:8081/chat/completions
            └─ examples/proxy/server.mjs
                 └─ POST https://chat-ai.academiccloud.de/v1/chat/completions
```

The predefined configuration lives in
`examples/embedded-chatbot/config.js`:

```js
export const chatConfig = {
  endpoint: "http://127.0.0.1:8081",
  // Fallback for a plain Chat AI back service; the proxy overrides it when
  // secrets/back.json contains a model.
  model: "qwen3-30b-a3b-instruct-2507",
  // The proxy enforces the system prompt, sampling values, and limits from
  // secrets/back.json.
  title: "SAIA Assistant",
  aiDisclosure:
    "You are chatting with an AI assistant. Responses are generated automatically and may be inaccurate.",
  privacyLinkLabel: "Data privacy",
  privacyDetails: "…", // full statement in examples/embedded-chatbot/config.js
  welcome: "Hello! I am a small demo chatbot backed by SAIA…",
  placeholder: "Ask the SAIA assistant…",
  height: "30rem",
};
```

The SAIA endpoint, model, system prompt, sampling values, and limits are
configured in `secrets/back.json`:

```json
{
  "port": 8081,
  "host": "127.0.0.1",
  "apiEndpoint": "https://chat-ai.academiccloud.de/v1",
  "apiKey": "<your SAIA API key>",
  "model": "qwen3-30b-a3b-instruct-2507",
  "systemPrompt": "You are a helpful assistant embedded on a university webpage…",
  "temperature": 0.4,
  "topP": 0.8,
  "maxTokens": 1200,
  "maxMessages": 40,
  "maxInputChars": 30000,
  "serviceName": "Chat AI Tools"
}
```

### Backend-enforced request policy

The proxy builds the final chat request itself. It:

- drops every client `system`, `developer`, and `tool` message,
- keeps only `user` and `assistant` text messages,
- prepends the `systemPrompt` from `back.json`,
- pins `model`, `temperature`, `top_p`, and `max_tokens` from `back.json`,
- drops tools and unknown request fields,
- keeps at most `maxMessages` messages and rejects input above `maxInputChars`.

Client-side widget settings are UX defaults only. A user can still edit them in
the browser, but the proxy ignores them. To change the assistant’s prompt or
sampling behaviour, edit `secrets/back.json` and restart the proxy.

### Using an existing Chat AI back service

If you already run the Chat AI `back` service, you can skip `npm run proxy` and
point the widget at it:

```js
endpoint: "http://127.0.0.1:8081"
```

This bypasses the backend-enforced prompt and sampling policy of this
repository’s proxy. The Chat AI back service forwards the client request; it
does not enforce a server-side system prompt. Use the included proxy when the
prompt must not be changeable by the user.

The client appends `/chat/completions` and `/models`, which match the Chat AI
back service routes. The proxy in this repository supports the same routes and
also the `/v1/...` aliases. It enforces the model, system prompt, sampling
values, and limits from `back.json`; see the request policy above.

If port `8081` is already taken by the Chat AI back service, either use that
service directly (as above) or start this proxy on another port, for example:

```bash
PORT=8091 npm run proxy
```

Then set `endpoint: "http://127.0.0.1:8091"` in
`examples/embedded-chatbot/config.js`.

## Using the widget

```html
<script type="module" src="/src/chat-ai-widget.js"></script>

<chat-ai-widget id="chat"></chat-ai-widget>

<script type="module">
  await customElements.whenDefined("chat-ai-widget");
  document.querySelector("#chat").configure({
    endpoint: "http://127.0.0.1:8081",
    model: "qwen3-30b-a3b-instruct-2507",
    systemPrompt: "You are a helpful assistant.",
    title: "SAIA Assistant",
  });
</script>
```

The widget provides:

- an AI disclosure above the conversation,
- the official EU “fully AI-generated” badge next to the assistant title (black/white for light/dark mode),
- a **Data privacy** link next to the badge that opens the full statement in an in-widget dialog,
- optional popup mode with a fixed chat icon that opens and minimizes the panel,
- streaming responses,
- a stop button,
- a “New chat” button,
- Enter to send, Shift+Enter for a newline,
- light/dark styling via `prefers-color-scheme`,
- safe rendering with `textContent` (model output is never injected as HTML).

### Configuration

| Key | Default | Meaning |
|---|---|---|
| `endpoint` | `http://127.0.0.1:8081` | Base URL of the proxy or OpenAI-compatible endpoint |
| `model` | `""` | Model id. Leave empty when the proxy supplies it; the example sets a fallback. |
| `systemPrompt` | `""` | Optional client-side system message for direct mode; the included proxy ignores it and uses `back.json`. |
| `temperature` | `0.5` | Sampling temperature for direct mode; the included proxy pins it from `back.json`. |
| `topP` | `0.8` | Nucleus sampling for direct mode; the included proxy pins it from `back.json`. |
| `maxTokens` | `1024` | Maximum completion tokens for direct mode; the included proxy pins it from `back.json`. |
| `token` | `""` | Optional bearer token for direct mode. Prefer the proxy. |
| `serviceName` | `""` | Optional `inference-portal` header value |
| `title` | `SAIA Assistant` | Widget header text |
| `aiDisclosure` | Built-in AI notice | Text that clearly says the user is talking to an AI assistant |
| `privacyLinkLabel` | `Data privacy` | Label of the link/button next to the badge that opens the full statement |
| `privacyDetails` | Built-in privacy statement | Full statement shown in the dialog; paragraphs separated by blank lines |
| `aiIconAlt` | `AI-generated content` | Alt text for the EU AI-generated badge |
| `welcome` | `Hello! How can I help you today?` | Intro text shown before the first message |
| `placeholder` | `Type your message…` | Composer placeholder |
| `height` | `32rem` | Widget height |
| `popup` | `false` | Render as a fixed chat icon that opens/minimizes the widget panel |

String settings can also be passed as kebab-case attributes:

```html
<chat-ai-widget
  endpoint="http://127.0.0.1:8081"
  model="qwen3-30b-a3b-instruct-2507"
  system-prompt="You are a helpful assistant."
  title="SAIA Assistant"
></chat-ai-widget>
```

Sampling values (`temperature`, `topP`, `maxTokens`) and `token` are best set
with `configure()`. When using the included proxy, the model, system prompt,
sampling values, and limits are enforced from `secrets/back.json` and the client
values are ignored. The AI disclosure is rendered above the conversation. A
**Data privacy** link next to the EU AI-generated badge opens the full statement
in a dialog inside the widget. If a configured value is empty, the built-in
default is used, so the notice is never silently removed. The dialog renders
`privacyDetails` as plain text, never as HTML.

## Popup mode

Set `popup: true` with `configure()`, or use the boolean attribute:

```html
<chat-ai-widget popup endpoint="http://127.0.0.1:8081"></chat-ai-widget>
```

In popup mode the widget renders a fixed chat icon in the bottom-right corner.
Clicking the icon opens the panel; clicking it again minimizes the panel back to
the icon. The conversation stays in memory while minimized. The launcher has an
accessible label and `aria-expanded`, and the panel keeps the AI disclosure, EU
badge, and Data privacy link.

See `examples/popup-chatbot/` for a complete page.

## AI-generated content badge

The widget displays the official EU badge for **fully AI-generated content**
next to the assistant title. The **Data privacy** link sits next to the badge:

- `assets/eu-ai-icons/label-ai-generated-black.svg` for light mode,
- `assets/eu-ai-icons/label-ai-generated-white.svg` for dark mode.

Source: [EU Icons for labelling AI-generated content](https://digital-strategy.ec.europa.eu/en/policies/eu-icons-labelling-ai-generated-content).
The European Commission makes these icons freely available without a requirement
to attribute the Commission or the AI Office. Using the badge does not by itself
establish compliance with Article 50 of the AI Act.

The widget sets the icon’s alt text from `aiIconAlt` (or `ai-icon-alt`) and
switches between the black and white variants using `prefers-color-scheme`.
Deploy `assets/eu-ai-icons/` together with `src/chat-ai-widget.js`.

## Using the client directly

```js
import { ChatAIClient } from "./src/chat-ai-client.js";

const client = new ChatAIClient({
  endpoint: "http://127.0.0.1:8081",
  // token: "…", // only for direct endpoints
});

for await (const token of client.streamChat(
  [
    { role: "system", content: "You are a helpful assistant." },
    { role: "user", content: "What is SAIA?" },
  ],
  { model: "qwen3-30b-a3b-instruct-2507" },
)) {
  process.stdout.write(token);
}
```

The client also provides `chat()` for a single non-streaming answer and
`listModels()` for the model catalogue. It throws `ChatAIError` with `status` and
`body` when the endpoint fails. `listModels()` also rejects when a deployment
returns HTTP 200 with an error body, as SAIA can do when credentials are wrong.

## Local folder MCP server

`tools/local-folder-mcp/` provides a small, dependency-free Model Context
Protocol server for local folders. It is read-only and asks via a native dialog
before a folder is accessed:

- `request_folder_access`
- `list_folder`
- `read_file`
- `list_allowed_folders`

Each dialog offers **Allow for session**, **Allow once**, or **Deny**. Session
grants are remembered in memory until the server stops. On Linux, install
`zenity` or `kdialog`; Windows uses PowerShell/WinForms and macOS uses
`osascript`.

For Chat AI, start the URL-based HTTP mode:

```bash
npm run mcp:folder
```

It prints:

```text
local-folder-mcp HTTP server listening on 127.0.0.1:3921
Use the following MCP endpoint in Chat AI:
http://127.0.0.1:3921/mcp
```

Paste that URL into Chat AI’s MCP server settings. The HTTP mode binds to
`127.0.0.1` only. For MCP clients that spawn a child process, use
`node tools/local-folder-mcp/server.mjs` (stdio) or `npm run mcp:folder:stdio`.

See [tools/local-folder-mcp/README.md](tools/local-folder-mcp/README.md) for the
MCP client configuration and security notes.

### Windows installation

The MCP server can be shipped as a single `local-folder-mcp.exe` with no Node.js
installation. Windows PowerShell (built into Windows) provides the confirmation
dialogs; `zenity`/`kdialog` are not needed on Windows.

See [README-Windows.txt](README-Windows.txt) for the complete build, install,
configuration, update, uninstall, and troubleshooting guide.

Build it **on Windows** (the script copies the running `node.exe`):

```powershell
npm ci
npm run build:windows
```

Then install Inno Setup 6 and build the per-user installer:

```powershell
& "C:\Program Files (x86)\Inno Setup 6\ISCC.exe" build\windows\installer.iss
```

Artifacts:

- `build/windows/out/local-folder-mcp.exe` — standalone executable.
- `build/windows/out/local-folder-mcp-setup.exe` — installer.

The installer installs into `%LOCALAPPDATA%` and adds a Start Menu shortcut. The
shortcut starts the server in HTTP mode and prints the Chat AI endpoint, for
example `http://127.0.0.1:3921/mcp`.

You can also run the **Build Windows installer** GitHub Actions workflow
manually and download the artifact. The executable and installer are unsigned;
sign them before distributing them broadly to avoid SmartScreen warnings.

Use the endpoint from a Chat AI instance served locally over HTTP
(`http://localhost` or `http://127.0.0.1`). An HTTPS-hosted Chat AI page may block
the local HTTP MCP endpoint as mixed content.

## Thunderbird MCP server

`tools/thunderbird-mcp/` is a separate local MCP server that reads Thunderbird
mail and creates drafts through a privileged Thunderbird extension. It never
sends mail, never uses IMAP/SMTP credentials, and supports stdio or a localhost
Streamable HTTP endpoint.

Mail access uses the same native confirmation dialog as the local folder MCP
server: the user confirms each mailbox and can allow it for the session. Mutating
actions - creating a draft, marking a message read/unread, changing its priority,
and marking it answered - show a separate confirmation dialog and are remembered
per action and account. The user can allow once, allow for the session, or deny.
See [tools/thunderbird-mcp/README.md](tools/thunderbird-mcp/README.md) and
[RUNNING.md](tools/thunderbird-mcp/RUNNING.md).

## Direct SAIA access

For a direct connection, set:

```js
endpoint: "https://chat-ai.academiccloud.de/v1"
token: "<short-lived user token>"
```

Caveats:

- A token in browser code is visible to every visitor. Use the proxy for public
  pages.
- Direct browser calls can be blocked by CORS. The local proxy avoids that.
- Do not put a long-lived API key in a webpage.

## Development

```bash
npm test                  # client and server tests
npm run dev               # static server on :8080
npm run proxy             # proxy on :8081
npm run mcp:folder        # local folder MCP server over HTTP
npm run mcp:folder:stdio  # local folder MCP server over stdio
```

Environment overrides:

- `PORT` — static server or proxy port.
- `HOST` — loopback bind address. Only `127.0.0.1` or `::1` is accepted;
  anything else is refused.
- `CORS_ORIGIN` — comma-separated allowed origins. By default, localhost and
  127.0.0.1 browser origins are accepted. `*` allows every website to call the
  local proxy and should not be used.
- `CONFIG_LOCATION` — proxy config path (default `secrets/back.json`).

The static server redirects `/` to the example page. It serves the repository
root, so module imports such as `../../src/chat-ai-widget.js` work without a
build step.

## Production notes

The example proxy is intentionally small and intended for local development. It
refuses non-loopback hosts and accepts only local browser origins by default.
For remote access, put a properly authenticated service behind a TLS-terminating
reverse proxy; do not change this proxy to listen on `0.0.0.0`.

Additional production hardening:

- authentication and authorization,
- rate limiting and request-size limits,
- logging that never includes message content or secrets.

## Adding a tool

Reusable code belongs in `src/`, examples in `examples/<name>/`, and tests in
`tests/`. Every new tool or example must be documented and exercised. See
[AGENTS.md](AGENTS.md) for the full checklist and security invariants.
