import assert from "node:assert/strict";
import test from "node:test";

import { applyBackendModel } from "../examples/proxy/model-override.mjs";

test("replaces the client model with the backend model", () => {
  const raw = Buffer.from(
    JSON.stringify({ model: "client-model", messages: [] }),
  );
  const result = JSON.parse(
    applyBackendModel(raw, "backend-model").toString("utf8"),
  );

  assert.equal(result.model, "backend-model");
  assert.deepEqual(result.messages, []);
});

test("leaves the request untouched without a backend model", () => {
  const raw = Buffer.from(JSON.stringify({ model: "client-model" }));
  assert.equal(applyBackendModel(raw, ""), raw);
});

test("rejects invalid JSON", () => {
  assert.throws(
    () => applyBackendModel(Buffer.from("{"), "backend-model"),
    /Invalid JSON/,
  );
});
