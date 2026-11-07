import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function run(script, env) {
  return spawnSync(process.execPath, [path.join(root, script)], {
    env: { ...process.env, ...env },
    encoding: "utf8",
    timeout: 10_000,
  });
}

test("proxy refuses to bind to a non-loopback address", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-bind-"));
  const configPath = path.join(dir, "back.json");
  fs.writeFileSync(
    configPath,
    JSON.stringify({
      apiEndpoint: "https://example.test/v1",
      apiKey: "test",
      model: "test",
      systemPrompt: "test",
    }),
  );

  try {
    const result = run("examples/proxy/server.mjs", {
      HOST: "0.0.0.0",
      CONFIG_LOCATION: configPath,
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Refusing to listen/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("development server refuses to bind to a non-loopback address", () => {
  const result = run("scripts/serve.mjs", { HOST: "0.0.0.0" });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Refusing to listen/);
});
