import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

const TOKEN = "Zinnober";

async function freePort(): Promise<number> {
  const server = createNetServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  server.close();
  await once(server, "close");
  return port;
}

async function waitForHealth(port: number): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`);
      if (response.ok) return;
    } catch {
      // Server is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("HTTP MCP server did not start");
}

async function rpc(
  port: number,
  body: unknown,
  token: string | null = TOKEN,
  session?: string,
): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(session ? { "Mcp-Session-Id": session } : {}),
    },
    body: JSON.stringify(body),
  });
}

test("HTTP transport requires Bearer auth and answers CORS preflight", async (t) => {
  const port = await freePort();
  const directory = mkdtempSync(path.join(tmpdir(), "crm-mcp-test-"));
  const dbPath = path.join(directory, "crm.db");
  const child = spawn(
    process.execPath,
    [
      "--import",
      "tsx",
      "src/index.ts",
      "--http",
      "--host",
      "127.0.0.1",
      "--port",
      String(port),
      "--db",
      dbPath,
      "--password",
      TOKEN,
    ],
    { stdio: ["ignore", "ignore", "ignore"] },
  );
  t.after(async () => {
    if (child.exitCode === null) {
      child.kill("SIGTERM");
      await new Promise<void>((resolve) => child.once("exit", () => resolve()));
    }
    rmSync(directory, { recursive: true, force: true });
  });

  await waitForHealth(port);

  const preflight = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: "OPTIONS",
    headers: {
      Origin: "http://localhost:8080",
      "Access-Control-Request-Method": "POST",
      "Access-Control-Request-Headers":
        "content-type, accept, authorization, mcp-protocol-version, mcp-session-id",
      "Access-Control-Request-Private-Network": "true",
    },
  });
  assert.equal(preflight.status, 204);
  assert.equal(
    preflight.headers.get("access-control-allow-origin"),
    "http://localhost:8080",
  );
  assert.match(
    preflight.headers.get("access-control-allow-headers") || "",
    /mcp-protocol-version/i,
  );
  assert.equal(
    preflight.headers.get("access-control-allow-private-network"),
    "true",
  );

  const blockedPreflight = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: "OPTIONS",
    headers: {
      Origin: "http://evil.example",
      "Access-Control-Request-Method": "POST",
    },
  });
  assert.equal(blockedPreflight.status, 204);
  assert.equal(
    blockedPreflight.headers.get("access-control-allow-origin"),
    null,
  );

  const unauthorized = await rpc(
    port,
    {
      jsonrpc: "2.0",
      id: 0,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "crm-http-test", version: "0.1.0" },
      },
    },
    null,
  );
  assert.equal(unauthorized.status, 401);

  const initialized = await rpc(port, {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "crm-http-test", version: "0.1.0" },
    },
  });
  assert.equal(initialized.status, 200);
  const session = initialized.headers.get("mcp-session-id");
  assert.ok(session);

  const listed = await rpc(
    port,
    { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
    TOKEN,
    session,
  );
  const body = (await listed.json()) as {
    result?: { tools?: Array<{ name: string }> };
  };
  assert.ok(
    body.result?.tools?.some((tool) => tool.name === "create_contact"),
  );
});
