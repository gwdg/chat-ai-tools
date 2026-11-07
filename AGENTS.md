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
│   └── proxy/
│       ├── server.mjs         Minimal server-side proxy for Chat AI / SAIA
│       └── model-override.mjs Applies the backend-configured model
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

- The widget talks to an OpenAI-compatible endpoint.
- The proxy holds the long-lived SAIA API key and forwards only the model list
  and chat completion requests.
- The proxy can set the model centrally from `secrets/back.json`; it overrides a
  model sent by the browser.
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

`model` is optional in the client. If the widget has no model configured, the
request omits it and the proxy supplies the model from `back.json`. The example
page sets a fallback model so it also works against a plain Chat AI back service.
The proxy must keep overriding the client model when a backend model is
configured; do not let a webpage select arbitrary models.

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
- The proxy forwards only `/models` and `/chat/completions` (plus their `/v1`
  aliases) and `/health`. Do not turn it into an open forward proxy.
- `CORS_ORIGIN=*` is for local development. Restrict it in production.
- Do not log message content, request bodies, or API keys. The proxy logs only
  method, path, status, and duration.
- Add authentication, rate limiting, and request-size limits before exposing the
  proxy on the public internet.

## Adding a tool or example

Every new tool or example must be documented. A feature is not complete until:

1. Reusable code lives in `src/`, examples live in `examples/<name>/`.
2. The README (or a local README) explains purpose, configuration, and how to
   run it.
3. Logic has at least one test in `tests/` using `node:test`.
4. Example configuration contains no secrets.
5. `npm test` passes.
6. The example has been started with `npm run dev` / `npm run proxy` and
   exercised, not just compiled.
7. `AGENTS.md` is updated only with constraints verified in the code.

Do not add a dependency when a built-in browser or Node API is sufficient.

## Public API and conventions

Keep these names stable unless a breaking change is intentional:

- `ChatAIClient`, `ChatAIError`, `completionsUrl`, `modelsUrl`
- `ChatAIWidget`, the `chat-ai-widget` custom element
- Widget configuration keys: `endpoint`, `model`, `systemPrompt`,
  `temperature`, `topP`, `maxTokens`, `token`, `serviceName`, `title`,
  `aiDisclosure`, `privacyLinkLabel`, `privacyDetails`, `aiIconAlt`,
  `welcome`, `placeholder`, `height`
- String attributes use kebab-case (`system-prompt`, `service-name`).
  Sampling values (`temperature`, `topP`, `maxTokens`) are set with
  `configure()`.

Code style:

- Vanilla ES modules, `type: "module"`.
- No build step and no framework.
- Browser code must not use Node built-ins.
- Node code uses `node:` imports.
- Prefer `textContent` over HTML injection.
- Keep the client and widget usable without the example proxy.

## Commands

```bash
npm test          # node:test suite
npm run dev       # static server on :8080, redirects / to the example
npm run proxy     # proxy on :8081, reads secrets/back.json
```

Environment overrides:

- `PORT` — port for the static server or proxy.
- `CORS_ORIGIN` — proxy CORS origin (default `*`).
- `CONFIG_LOCATION` — path to the proxy config (default `secrets/back.json`).

## Definition of done

- [ ] `npm test` passes.
- [ ] The example page loads through `npm run dev`.
- [ ] The proxy answers `/models` and `/chat/completions`.
- [ ] The AI disclosure is visible in the widget.
- [ ] The Data privacy link is next to the EU badge and opens the full statement
      in the dialog.
- [ ] The official EU fully AI-generated badge is next to the assistant title,
      visible, and has alt text.
- [ ] The backend model from `secrets/back.json` overrides the request model.
- [ ] No secret is present in tracked files.
- [ ] New configuration and usage are documented in `README.md`.
- [ ] Model output is written with `textContent`, never injected as HTML.
- [ ] The change still works without the local proxy (for example against an
      existing Chat AI back service or a direct endpoint).

## Maintaining this file

Add rules only after verifying them in the repository. Keep this file to facts
and requirements, not task logs, plans, or status updates. If a rule becomes
wrong, fix it instead of working around it.
