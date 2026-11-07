// Predefined configuration for the embedded chatbot example.
//
// The widget talks to the local proxy from examples/proxy/server.mjs. The proxy
// keeps the SAIA API key on the server and forwards requests to
// https://chat-ai.academiccloud.de/v1 (see secrets/back.json.example).
//
// For a direct browser connection, set:
//   endpoint: "https://chat-ai.academiccloud.de/v1"
//   token: "<short-lived user token>"
// Direct calls may be blocked by CORS, and a token in browser code is visible
// to every visitor. Prefer the proxy for anything public.

export const chatConfig = {
  endpoint: "http://localhost:8081",
  // Model, system prompt, sampling values, and limits are enforced by the proxy
  // from secrets/back.json. This fallback model is only used when the page talks
  // to a plain Chat AI back service without the included proxy.
  model: "qwen3-30b-a3b-instruct-2507",
  title: "SAIA Assistant",
  aiDisclosure:
    "You are chatting with an AI assistant. Responses are generated automatically and may be inaccurate.",
  privacyLinkLabel: "Data privacy",
  privacyDetails: `This demo sends the messages you enter to the configured SAIA endpoint for processing. The widget keeps the conversation only in this page's memory.

The local proxy logs only request metadata (method, path, status, duration). It never logs message content or the API key.

Do not enter personal, confidential, or sensitive information. The operator of this page and the AI provider may process messages according to their own policies.`,
  welcome:
    "Hello! I am a small demo chatbot backed by SAIA. Ask me anything about this page or the service.",
  placeholder: "Ask the SAIA assistant…",
  height: "30rem",
};
