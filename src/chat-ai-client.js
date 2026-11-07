// Small, dependency-free client for OpenAI-compatible Chat AI / SAIA endpoints.
// Works in modern browsers and Node 18+ (global fetch, ReadableStream).

export class ChatAIError extends Error {
  constructor(message, status, body) {
    super(message);
    this.name = "ChatAIError";
    this.status = status;
    this.body = body;
  }
}

const trimBase = (endpoint) => String(endpoint || "").trim().replace(/\/+$/, "");
const hasCompletionsPath = (endpoint) => /\/chat\/completions$/i.test(endpoint);

/** The full URL for a chat completion request. */
export function completionsUrl(endpoint) {
  const base = trimBase(endpoint);
  return hasCompletionsPath(base) ? base : `${base}/chat/completions`;
}

/** The full URL for a model list request. */
export function modelsUrl(endpoint) {
  const base = trimBase(endpoint).replace(/\/chat\/completions$/i, "");
  return `${base}/models`;
}

function contentToText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (typeof part === "string") return part;
      return typeof part?.text === "string" ? part.text : "";
    })
    .join("");
}

async function responseError(response) {
  let body = "";
  try {
    body = await response.text();
  } catch {
    // The body may already be consumed or unavailable.
  }

  let message = `Chat AI request failed with HTTP ${response.status}`;
  try {
    const parsed = JSON.parse(body);
    message = parsed?.error?.message || parsed?.message || message;
  } catch {
    // Keep the generic message when the body is not JSON.
  }

  return new ChatAIError(message, response.status, body);
}

export class ChatAIClient {
  /**
   * @param {object} options
   * @param {string} options.endpoint  Base URL, e.g. "https://chat-ai.academiccloud.de/v1"
   * @param {string} [options.token]   Bearer token for direct use. Prefer a proxy in browsers.
   * @param {string} [options.apiKey]  Alias for token.
   * @param {string} [options.serviceName] Optional "inference-portal" header value.
   * @param {typeof fetch} [options.fetchImpl] Injectable fetch implementation.
   */
  constructor({ endpoint, token, apiKey, serviceName, fetchImpl } = {}) {
    this.endpoint = trimBase(endpoint);
    this.token = String(token || apiKey || "");
    this.serviceName = String(serviceName || "");
    // The browser's fetch must be called with the global object as `this`;
    // injected test implementations are used as they are.
    this.fetchImpl = fetchImpl || globalThis.fetch?.bind(globalThis) || null;
  }

  headers({ streaming = false, json = false } = {}) {
    const headers = {};
    if (json) headers["Content-Type"] = "application/json";
    if (streaming) headers.Accept = "text/event-stream";
    if (this.token) headers.Authorization = `Bearer ${this.token}`;
    if (this.serviceName) headers["inference-portal"] = this.serviceName;
    return headers;
  }

  assertReady() {
    if (!this.endpoint) throw new Error("ChatAIClient needs an endpoint");
    if (typeof this.fetchImpl !== "function") {
      throw new Error("No fetch implementation is available");
    }
  }

  async request(url, body, { signal } = {}) {
    this.assertReady();
    return this.fetchImpl(url, {
      method: "POST",
      headers: this.headers({
        streaming: body?.stream === true,
        json: true,
      }),
      body: JSON.stringify(body),
      signal,
    });
  }

  async listModels({ signal } = {}) {
    this.assertReady();
    const response = await this.fetchImpl(modelsUrl(this.endpoint), {
      method: "GET",
      headers: this.headers(),
      signal,
    });
    if (!response.ok) throw await responseError(response);

    const data = await response.json();
    const entries = Array.isArray(data?.data)
      ? data.data
      : Array.isArray(data)
        ? data
        : [];

    const ids = entries
      .map((entry) => (typeof entry === "string" ? entry : entry?.id))
      .filter((id) => typeof id === "string" && id.length > 0);

    // Some deployments answer /models with HTTP 200 and an error body instead
    // of a failing status. Do not silently return an empty model list.
    const errorMessage = data?.error?.message || data?.message;
    if (ids.length === 0 && errorMessage) {
      throw new ChatAIError(
        String(errorMessage),
        response.status,
        JSON.stringify(data),
      );
    }

    return ids;
  }

  /**
   * One non-streaming completion. Returns the assistant text.
   */
  async chat(messages, options = {}) {
    const {
      model,
      temperature = 0.5,
      topP = 0.8,
      maxTokens,
      signal,
      ...extra
    } = options;

    const body = {
      messages,
      temperature,
      top_p: topP,
      stream: false,
      ...extra,
    };
    if (model) body.model = model;
    if (Number.isFinite(maxTokens)) body.max_tokens = maxTokens;

    const response = await this.request(completionsUrl(this.endpoint), body, {
      signal,
    });
    if (!response.ok) throw await responseError(response);

    const data = await response.json();
    return contentToText(data?.choices?.[0]?.message?.content);
  }

  /**
   * Streaming completion. Yields text deltas as they arrive.
   */
  async *streamChat(messages, options = {}) {
    const {
      model,
      temperature = 0.5,
      topP = 0.8,
      maxTokens,
      signal,
      ...extra
    } = options;

    const body = {
      messages,
      temperature,
      top_p: topP,
      stream: true,
      ...extra,
    };
    if (model) body.model = model;
    if (Number.isFinite(maxTokens)) body.max_tokens = maxTokens;

    const response = await this.request(completionsUrl(this.endpoint), body, {
      signal,
    });
    if (!response.ok) throw await responseError(response);

    const contentType = response.headers.get("content-type") || "";

    // Some proxies ignore stream=true and return a normal JSON response.
    if (!contentType.includes("text/event-stream")) {
      const data = await response.json();
      const text = contentToText(data?.choices?.[0]?.message?.content);
      if (text) yield text;
      return;
    }

    if (!response.body) {
      throw new ChatAIError(
        "The endpoint returned an empty streaming response",
        response.status,
        "",
      );
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const events = buffer.split(/\r?\n\r?\n/);
        buffer = events.pop() ?? "";

        for (const event of events) {
          const dataLines = event
            .split(/\r?\n/)
            .filter((line) => line.startsWith("data:"));
          if (dataLines.length === 0) continue;

          const data = dataLines.map((line) => line.slice(5).trim()).join("\n");
          if (data === "[DONE]") return;
          if (!data) continue;

          let parsed;
          try {
            parsed = JSON.parse(data);
          } catch {
            continue;
          }

          const delta =
            parsed?.choices?.[0]?.delta?.content ??
            parsed?.choices?.[0]?.text;
          const text = contentToText(delta);
          if (text) yield text;
        }
      }
    } finally {
      reader.releaseLock();
    }
  }
}
