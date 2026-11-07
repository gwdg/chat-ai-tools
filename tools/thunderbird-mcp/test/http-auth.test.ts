import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer as createNetServer } from "node:net";
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

interface RpcResponse {
  status: number;
  session?: string;
  body: string;
}

async function rpc(
  port: number,
  body: unknown,
  session?: string,
  token: string | undefined = TOKEN,
): Promise<RpcResponse> {
  const response = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(session ? { "Mcp-Session-Id": session } : {}),
    },
    body: JSON.stringify(body),
  });
  return {
    status: response.status,
    session: response.headers.get("mcp-session-id") ?? undefined,
    body: await response.text(),
  };
}

async function initialize(port: number): Promise<string> {
  const response = await rpc(port, {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "http-auth-test", version: "1.0.0" },
    },
  });
  assert.ok(response.session, "server must return an MCP session id");
  await rpc(port, { jsonrpc: "2.0", method: "notifications/initialized" }, response.session);
  return response.session;
}

async function callTool(
  port: number,
  session: string,
  id: number,
  name: string,
  args: Record<string, unknown>,
): Promise<string> {
  const response = await rpc(
    port,
    { jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } },
    session,
  );
  const parsed = JSON.parse(response.body) as {
    result?: { content?: Array<{ text?: string }> };
  };
  return parsed.result?.content?.map((item) => item.text ?? "").join("") ?? "";
}

test("HTTP transport enforces Bearer auth and CORS", async (t) => {
  const port = await freePort();
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
      "--password",
      "Zinnober",
    ],
    { stdio: ["ignore", "ignore", "ignore"] },
  );
  t.after(async () => {
    if (child.exitCode === null) {
      child.kill("SIGTERM");
      await new Promise<void>((resolve) => child.once("exit", () => resolve()));
    }
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
        clientInfo: { name: "http-auth-test", version: "1.0.0" },
      },
    },
    undefined,
    "",
  );
  assert.equal(unauthorized.status, 401);

  const first = await initialize(port);
  assert.match(
    await callTool(port, first, 2, "list_profiles", {}),
    /"selected"/,
  );

  const second = await initialize(port);
  assert.match(
    await callTool(port, second, 3, "list_profiles", {}),
    /"selected"/,
  );
});
