import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  createFolderServer,
  createHttpServer,
} from "../tools/local-folder-mcp/server.mjs";

async function withServer(run) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-http-"));
  await fs.mkdir(path.join(root, "sub"));
  await fs.writeFile(path.join(root, "a.txt"), "hello");

  const calls = [];
  const dialog = async (request) => {
    calls.push(request);
    return "session";
  };
  const folderServer = createFolderServer({ dialog, cwd: root });
  const server = createHttpServer({ folderServer, corsOrigins: [] });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;

  try {
    await run({ base, calls, root });
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(root, { recursive: true, force: true });
  }
}

const rpc = (base, payload, headers = {}) =>
  fetch(`${base}/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      ...headers,
    },
    body: JSON.stringify(payload),
  });

test("serves MCP initialize and tool calls over HTTP", async () => {
  await withServer(async ({ base, calls }) => {
    const initResponse = await rpc(
      base,
      {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-06-18" },
      },
      { Origin: "http://127.0.0.1:8080" },
    );

    assert.equal(initResponse.status, 200);
    assert.equal(
      initResponse.headers.get("access-control-allow-origin"),
      "http://127.0.0.1:8080",
    );
    assert.match(
      initResponse.headers.get("access-control-allow-headers") || "",
      /mcp-protocol-version/i,
    );
    const init = await initResponse.json();
    assert.equal(init.result.serverInfo.name, "local-folder-mcp");

    const listResponse = await rpc(base, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
    });
    const list = await listResponse.json();
    assert.deepEqual(
      list.result.tools.map((tool) => tool.name),
      [
        "request_folder_access",
        "list_folder",
        "read_file",
        "list_allowed_folders",
      ],
    );

    const callResponse = await rpc(base, {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "list_folder", arguments: { path: "." } },
    });
    const called = await callResponse.json();
    assert.match(called.result.content[0].text, /a\.txt/);
    assert.equal(calls.length, 1);
  });
});

test("handles notifications, health, CORS rejection, and unsupported GET", async () => {
  await withServer(async ({ base }) => {
    const notification = await rpc(base, {
      jsonrpc: "2.0",
      method: "notifications/initialized",
    });
    assert.equal(notification.status, 202);

    const health = await fetch(`${base}/health`);
    assert.deepEqual(await health.json(), { ok: true });

    const blocked = await fetch(`${base}/mcp`, {
      method: "OPTIONS",
      headers: { Origin: "http://evil.example" },
    });
    assert.equal(blocked.status, 204);
    assert.equal(blocked.headers.get("access-control-allow-origin"), null);

    const stream = await fetch(`${base}/mcp`, {
      method: "GET",
      headers: { Accept: "text/event-stream" },
    });
    assert.equal(stream.status, 405);
  });
});

test("returns JSON-RPC errors for malformed requests", async () => {
  await withServer(async ({ base }) => {
    const invalidJson = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{",
    });
    assert.equal(invalidJson.status, 400);
    assert.equal((await invalidJson.json()).error.code, -32700);

    const invalidRequest = await rpc(base, {
      jsonrpc: "2.0",
      id: 9,
      method: "resources/list",
    });
    const body = await invalidRequest.json();
    assert.equal(body.error.code, -32601);
  });
});
