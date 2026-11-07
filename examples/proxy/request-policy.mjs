// Builds the final chat completion request on the server. The browser may send
// any options, but only user/assistant text messages survive; the model,
// system prompt, sampling values, and limits come from back.json.

const DEFAULT_SYSTEM_PROMPT = "You are a helpful assistant.";
const DEFAULT_TEMPERATURE = 0.5;
const DEFAULT_TOP_P = 0.8;
const DEFAULT_MAX_TOKENS = 1024;
const DEFAULT_MAX_MESSAGES = 40;
const DEFAULT_MAX_INPUT_CHARS = 30000;

function fail(message, status = 400) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function numberInRange(value, fallback, min, max) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(parsed, min), max);
}

function integerInRange(value, fallback, min, max) {
  return Math.trunc(numberInRange(value, fallback, min, max));
}

function normalizeMessages(input) {
  if (!Array.isArray(input)) throw fail("messages must be an array");

  const messages = [];
  for (const message of input) {
    if (!message || typeof message !== "object") continue;
    if (message.role !== "user" && message.role !== "assistant") continue;
    if (typeof message.content !== "string") continue;
    if (!message.content.trim()) continue;
    messages.push({ role: message.role, content: message.content });
  }

  return messages;
}

export function prepareChatRequest(rawBody, config = {}) {
  let parsed;
  try {
    parsed = JSON.parse(rawBody.toString("utf8"));
  } catch {
    throw fail("Invalid JSON request body");
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw fail("Invalid JSON request body");
  }

  const model = String(config.model || "").trim();
  if (!model) throw fail("The proxy has no model configured", 500);

  const messages = normalizeMessages(parsed.messages);
  if (messages.length === 0) throw fail("No user message provided");

  const systemPrompt =
    String(config.systemPrompt || DEFAULT_SYSTEM_PROMPT).trim() ||
    DEFAULT_SYSTEM_PROMPT;
  const maxMessages = integerInRange(
    config.maxMessages,
    DEFAULT_MAX_MESSAGES,
    1,
    200,
  );
  const keptMessages = messages.slice(-maxMessages);
  const maxInputChars = integerInRange(
    config.maxInputChars,
    DEFAULT_MAX_INPUT_CHARS,
    1,
    2_000_000,
  );
  const totalChars = keptMessages.reduce(
    (sum, message) => sum + message.content.length,
    systemPrompt.length,
  );
  if (totalChars > maxInputChars) {
    throw fail(`Input exceeds ${maxInputChars} characters`, 413);
  }

  const body = {
    model,
    messages: [
      { role: "system", content: systemPrompt },
      ...keptMessages,
    ],
    temperature: numberInRange(
      config.temperature,
      DEFAULT_TEMPERATURE,
      0,
      2,
    ),
    top_p: numberInRange(config.topP, DEFAULT_TOP_P, 0, 1),
    max_tokens: integerInRange(
      config.maxTokens,
      DEFAULT_MAX_TOKENS,
      1,
      32000,
    ),
    stream: parsed.stream !== false,
  };

  return Buffer.from(JSON.stringify(body));
}
