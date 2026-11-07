import assert from "node:assert/strict";
import test from "node:test";

import {
  ChatAIClient,
  ChatAIError,
  completionsUrl,
  modelsUrl,
} from "../src/chat-ai-client.js";

const jsonResponse = (value, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });

test("builds completion and model URLs", () => {
  assert.equal(
    completionsUrl("https://example.test/v1/"),
    "https://example.test/v1/chat/completions",
  );
  assert.equal(
    completionsUrl("https://example.test/v1/chat/completions"),
    "https://example.test/v1/chat/completions",
  );
  assert.equal(
    modelsUrl("https://example.test/v1"),
    "https://example.test/v1/models",
  );
  assert.equal(
    modelsUrl("https://example.test/v1/chat/completions"),
    "https://example.test/v1/models",
  );
});

test("sends a non-streaming completion and returns the text", async () => {
  let captured;
  const client = new ChatAIClient({
    endpoint: "https://example.test/v1",
    token: "secret",
    fetchImpl: async (url, init) => {
      captured = { url, init };
      return jsonResponse({ choices: [{ message: { content: "Hello" } }] });
    },
  });

  const text = await client.chat([{ role: "user", content: "Hi" }], {
    model: "demo-model",
    temperature: 0.2,
    topP: 0.5,
    maxTokens: 128,
  });

  assert.equal(text, "Hello");
  assert.equal(captured.url, "https://example.test/v1/chat/completions");
  assert.equal(captured.init.headers.Authorization, "Bearer secret");

  const body = JSON.parse(captured.init.body);
  assert.equal(body.model, "demo-model");
  assert.equal(body.stream, false);
  assert.equal(body.max_tokens, 128);
  assert.deepEqual(body.messages, [{ role: "user", content: "Hi" }]);
});

test("omits the model when the backend should choose it", async () => {
  let captured;
  const client = new ChatAIClient({
    endpoint: "https://example.test/v1",
    fetchImpl: async (_url, init) => {
      captured = init;
      return jsonResponse({ choices: [{ message: { content: "Hello" } }] });
    },
  });

  await client.chat([{ role: "user", content: "Hi" }]);
  const body = JSON.parse(captured.body);
  assert.equal("model" in body, false);
});

test("streams text deltas from SSE", async () => {
  const sse = [
    'data: {"choices":[{"delta":{"content":"Hel"}}]}',
    "",
    'data: {"choices":[{"delta":{"content":"lo"}}]}',
    "",
    "data: [DONE]",
    "",
  ].join("\n");

  const client = new ChatAIClient({
    endpoint: "https://example.test/v1",
    fetchImpl: async () =>
      new Response(sse, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      }),
  });

  const tokens = [];
  for await (const token of client.streamChat(
    [{ role: "user", content: "Say hello" }],
    { model: "demo-model" },
  )) {
    tokens.push(token);
  }

  assert.deepEqual(tokens, ["Hel", "lo"]);
});

test("accepts a JSON response even when streaming was requested", async () => {
  const client = new ChatAIClient({
    endpoint: "https://example.test/v1",
    fetchImpl: async () =>
      jsonResponse({ choices: [{ message: { content: "Fallback" } }] }),
  });

  const tokens = [];
  for await (const token of client.streamChat([], { model: "demo-model" })) {
    tokens.push(token);
  }

  assert.deepEqual(tokens, ["Fallback"]);
});

test("throws a ChatAIError with the upstream message", async () => {
  const client = new ChatAIClient({
    endpoint: "https://example.test/v1",
    fetchImpl: async () =>
      jsonResponse({ error: { message: "Unauthorized" } }, 401),
  });

  await assert.rejects(
    () => client.chat([{ role: "user", content: "Hi" }], { model: "demo" }),
    (error) =>
      error instanceof ChatAIError &&
      error.status === 401 &&
      /Unauthorized/.test(error.message),
  );
});

test("rejects an error body returned with HTTP 200 by /models", async () => {
  const client = new ChatAIClient({
    endpoint: "https://example.test/v1",
    fetchImpl: async () =>
      jsonResponse({ message: "Unauthorized" }, 200),
  });

  await assert.rejects(
    () => client.listModels(),
    (error) =>
      error instanceof ChatAIError &&
      error.status === 200 &&
      /Unauthorized/.test(error.message),
  );
});

test("lists models", async () => {
  const client = new ChatAIClient({
    endpoint: "https://example.test/v1",
    fetchImpl: async (url, init) => {
      assert.equal(url, "https://example.test/v1/models");
      assert.equal(init.method, "GET");
      return jsonResponse({
        data: [{ id: "model-a" }, { id: "model-b" }],
      });
    },
  });

  assert.deepEqual(await client.listModels(), ["model-a", "model-b"]);
});
