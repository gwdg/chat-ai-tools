import assert from "node:assert/strict";
import test from "node:test";

import { prepareChatRequest } from "../examples/proxy/request-policy.mjs";

const config = {
  model: "backend-model",
  systemPrompt: "Backend prompt",
  temperature: 0.1,
  topP: 0.2,
  maxTokens: 50,
  maxMessages: 10,
  maxInputChars: 1000,
};

const prepare = (payload, overrides = {}) =>
  JSON.parse(
    prepareChatRequest(
      Buffer.from(JSON.stringify(payload)),
      { ...config, ...overrides },
    ).toString("utf8"),
  );

test("drops client system messages, tools, and unknown options", () => {
  const body = prepare({
    model: "client-model",
    messages: [
      { role: "system", content: "client system" },
      { role: "developer", content: "developer message" },
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi" },
      { role: "tool", content: "tool result" },
      { role: "user", content: [{ type: "text", text: "array content" }] },
    ],
    temperature: 2,
    top_p: 1,
    max_tokens: 9999,
    tools: [{ type: "function" }],
    stream: true,
  });

  assert.equal(body.model, "backend-model");
  assert.deepEqual(body.messages, [
    { role: "system", content: "Backend prompt" },
    { role: "user", content: "hello" },
    { role: "assistant", content: "hi" },
  ]);
  assert.equal(body.temperature, 0.1);
  assert.equal(body.top_p, 0.2);
  assert.equal(body.max_tokens, 50);
  assert.equal(body.stream, true);
  assert.equal("tools" in body, false);
});

test("keeps a non-streaming request non-streaming", () => {
  const body = prepare({
    messages: [{ role: "user", content: "hello" }],
    stream: false,
  });
  assert.equal(body.stream, false);
});

test("keeps only the last configured number of messages", () => {
  const body = prepare(
    {
      messages: [
        { role: "user", content: "one" },
        { role: "assistant", content: "two" },
        { role: "user", content: "three" },
        { role: "assistant", content: "four" },
      ],
    },
    { maxMessages: 2 },
  );

  assert.deepEqual(body.messages, [
    { role: "system", content: "Backend prompt" },
    { role: "user", content: "three" },
    { role: "assistant", content: "four" },
  ]);
});

test("uses the default system prompt when none is configured", () => {
  const body = prepare(
    { messages: [{ role: "user", content: "hello" }] },
    { systemPrompt: "" },
  );
  assert.equal(body.messages[0].content, "You are a helpful assistant.");
});

test("rejects invalid JSON", () => {
  assert.throws(
    () => prepareChatRequest(Buffer.from("{"), config),
    /Invalid JSON/,
  );
});

test("rejects requests without usable messages", () => {
  assert.throws(
    () => prepare({ messages: [] }),
    /No user message provided/,
  );
  assert.throws(
    () => prepare({ messages: [{ role: "system", content: "only system" }] }),
    /No user message provided/,
  );
});

test("rejects input above the character limit", () => {
  assert.throws(
    () =>
      prepare(
        { messages: [{ role: "user", content: "x".repeat(200) }] },
        { maxInputChars: 10 },
      ),
    (error) => error.status === 413 && /Input exceeds/.test(error.message),
  );
});

test("requires a backend model", () => {
  assert.throws(
    () => prepare({ messages: [{ role: "user", content: "hello" }] }, { model: "" }),
    (error) => error.status === 500 && /no model/.test(error.message),
  );
});
