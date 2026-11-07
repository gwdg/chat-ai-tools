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
| `examples/proxy/server.mjs` | Minimal Node proxy that keeps the SAIA API key on the server |
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
   # http://localhost:8081 -> https://chat-ai.academiccloud.de/v1
   ```

3. Start the static server in a second terminal:

   ```bash
   npm run dev
   ```

4. Open the example:

   <http://localhost:8080/examples/embedded-chatbot/>

The API key stays in `secrets/back.json`; it is never sent to the browser.

## How the example works

```
browser page
  └─ <chat-ai-widget>
       └─ POST http://localhost:8081/chat/completions
            └─ examples/proxy/server.mjs
                 └─ POST https://chat-ai.academiccloud.de/v1/chat/completions
```

The predefined configuration lives in
`examples/embedded-chatbot/config.js`:

```js
export const chatConfig = {
  endpoint: "http://localhost:8081",
  // Fallback for a plain Chat AI back service; the proxy overrides it when
  // secrets/back.json contains a model.
  model: "qwen3-30b-a3b-instruct-2507",
  systemPrompt: "You are a helpful assistant embedded on a university webpage…",
  temperature: 0.4,
  topP: 0.8,
  maxTokens: 1200,
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

The SAIA endpoint and the model are configured in `secrets/back.json`. When a
`model` is present there, the proxy replaces the model sent by the page, so the
backend stays in control:

```json
{
  "port": 8081,
  "apiEndpoint": "https://chat-ai.academiccloud.de/v1",
  "apiKey": "<your SAIA API key>",
  "model": "qwen3-30b-a3b-instruct-2507",
  "serviceName": "Chat AI Tools"
}
```

### Using an existing Chat AI back service

If you already run the Chat AI `back` service, you can skip `npm run proxy` and
point the widget at it:

```js
endpoint: "http://localhost:8081"
```

The client appends `/chat/completions` and `/models`, which match the Chat AI
back service routes. The proxy in this repository supports the same routes and
also the `/v1/...` aliases. When the proxy has a `model` in `back.json`, it
overrides the model sent by the page, so the backend stays in control.

If port `8081` is already taken by the Chat AI back service, either use that
service directly (as above) or start this proxy on another port, for example:

```bash
PORT=8091 npm run proxy
```

Then set `endpoint: "http://localhost:8091"` in
`examples/embedded-chatbot/config.js`.

## Using the widget

```html
<script type="module" src="/src/chat-ai-widget.js"></script>

<chat-ai-widget id="chat"></chat-ai-widget>

<script type="module">
  await customElements.whenDefined("chat-ai-widget");
  document.querySelector("#chat").configure({
    endpoint: "http://localhost:8081",
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
- streaming responses,
- a stop button,
- a “New chat” button,
- Enter to send, Shift+Enter for a newline,
- light/dark styling via `prefers-color-scheme`,
- safe rendering with `textContent` (model output is never injected as HTML).

### Configuration

| Key | Default | Meaning |
|---|---|---|
| `endpoint` | `http://localhost:8081` | Base URL of the proxy or OpenAI-compatible endpoint |
| `model` | `""` | Model id. Leave empty when the proxy supplies it; the example sets a fallback. |
| `systemPrompt` | `You are a helpful assistant.` | System message |
| `temperature` | `0.5` | Sampling temperature |
| `topP` | `0.8` | Nucleus sampling |
| `maxTokens` | `1024` | Maximum completion tokens |
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

String settings can also be passed as kebab-case attributes:

```html
<chat-ai-widget
  endpoint="http://localhost:8081"
  model="qwen3-30b-a3b-instruct-2507"
  system-prompt="You are a helpful assistant."
  title="SAIA Assistant"
></chat-ai-widget>
```

Sampling values (`temperature`, `topP`, `maxTokens`) and `token` are best set
with `configure()`. The AI disclosure is rendered above the conversation. A
**Data privacy** link next to the EU AI-generated badge opens the full statement
in a dialog inside the widget. If a configured value is empty, the built-in
default is used, so the notice is never silently removed. The dialog renders
`privacyDetails` as plain text, never as HTML.

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
  endpoint: "http://localhost:8081",
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
npm test          # client tests
npm run dev       # static server on :8080
npm run proxy     # proxy on :8081
```

Environment overrides:

- `PORT` — static server or proxy port.
- `CORS_ORIGIN` — proxy CORS origin (default `*`; restrict in production).
- `CONFIG_LOCATION` — proxy config path (default `secrets/back.json`).

The static server redirects `/` to the example page. It serves the repository
root, so module imports such as `../../src/chat-ai-widget.js` work without a
build step.

## Production notes

The example proxy is intentionally small and intended for local development.
Before exposing it publicly, add:

- authentication and authorization,
- rate limiting and request-size limits,
- a restricted `CORS_ORIGIN`,
- logging that never includes message content or secrets,
- a TLS-terminating reverse proxy.

## Adding a tool

Reusable code belongs in `src/`, examples in `examples/<name>/`, and tests in
`tests/`. Every new tool or example must be documented and exercised. See
[AGENTS.md](AGENTS.md) for the full checklist and security invariants.
