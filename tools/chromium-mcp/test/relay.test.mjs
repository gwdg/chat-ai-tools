import assert from "node:assert/strict";
import test from "node:test";

import WebSocket from "ws";

import {
  createExtensionServer,
  createHttpServer,
  createMcpHandler,
  createRelay,
  TOOLS,
} from "../relay.mjs";
import {
  normalizeNavigationUrl,
  originOf,
  tabGrantKey,
} from "../extension/permissions.js";

function closeServer(server) {
  return new Promise((resolve) => server.close(resolve));
}

function waitForOpen(socket) {
  return new Promise((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
}

function waitForMessage(socket, predicate, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off("message", onMessage);
      reject(new Error("Timed out waiting for a WebSocket message."));
    }, timeoutMs);

    const onMessage = (raw) => {
      let message;
      try {
        message = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (!predicate(message)) return;
      clearTimeout(timer);
      socket.off("message", onMessage);
      resolve(message);
    };
    socket.on("message", onMessage);
  });
}

async function startHttpRelay(options = {}) {
  const relay = createRelay(options.relay ?? {});
  const mcp = createMcpHandler(relay);
  const server = createHttpServer({
    relay,
    mcp,
    token: options.token || "",
    corsOrigins: [],
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return {
    relay,
    server,
    base: `http://127.0.0.1:${port}`,
    wsUrl: `ws://127.0.0.1:${port}/extension`,
    async stop() {
      await closeServer(server);
      await relay.close();
    },
  };
}

async function connectExtension(wsUrl, { token, origin } = {}) {
  const socket = new WebSocket(wsUrl, {
    origin: origin || "chrome-extension://test",
  });
  await waitForOpen(socket);
  socket.send(
    JSON.stringify({
      type: "hello",
      token: token || "",
      version: "0.1.0",
      name: "chromium-mcp-extension",
    }),
  );
  const hello = await waitForMessage(
    socket,
    (message) => message.type === "hello-ok" || message.type === "hello-error",
  );
  return { socket, hello };
}

function rpc(base, payload, headers = {}) {
  return fetch(`${base}/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...headers,
    },
    body: JSON.stringify(payload),
  });
}

test("normalizes URLs and builds tab grant keys", () => {
  assert.equal(
    normalizeNavigationUrl("https://example.com/a"),
    "https://example.com/a",
  );
  for (const blocked of [
    "file:///etc/passwd",
    "javascript:alert(1)",
    "data:text/html,hi",
    "example.com",
  ]) {
    assert.throws(() => normalizeNavigationUrl(blocked), /http|scheme|URL/i);
  }

  assert.equal(originOf("https://example.com/path"), "https://example.com");
  assert.equal(originOf("chrome://settings"), null);
  assert.equal(
    tabGrantKey(7, "https://example.com/a"),
    "7|https://example.com",
  );
  assert.notEqual(
    tabGrantKey(7, "https://example.com/a"),
    tabGrantKey(7, "https://other.example/a"),
  );
  assert.equal(tabGrantKey(7, "chrome://settings"), null);
});

test("advertises browser tools and formats calls", async () => {
  const relay = {
    async call(method, params) {
      if (method === "tabs.list") {
        return [
          {
            id: 1,
            active: true,
            granted: true,
            title: "Example",
            url: "https://example.com/",
          },
        ];
      }
      if (method === "page.read") {
        return {
          url: "https://example.com/",
          title: "Example",
          text: "hello world",
          truncated: false,
        };
      }
      if (method === "page.screenshot") {
        return {
          tabId: 1,
          url: "https://example.com/",
          title: "Example",
          mimeType: "image/png",
          data: "iVBORw0KGgo=",
        };
      }
      return { method, params };
    },
    status() {
      return { connected: true, version: "0.1.0" };
    },
  };
  const mcp = createMcpHandler(relay);

  const init = await mcp.handle("initialize", {});
  assert.equal(init.serverInfo.name, "chromium-mcp");
  assert.equal(init.capabilities.tools !== undefined, true);

  const list = await mcp.handle("tools/list", {});
  assert.deepEqual(
    list.tools.map((tool) => tool.name),
    TOOLS.map((tool) => tool.name),
  );

  const status = await mcp.handle("tools/call", {
    name: "browser_status",
    arguments: {},
  });
  assert.match(status.content[0].text, /connected/i);

  const tabs = await mcp.handle("tools/call", {
    name: "browser_tabs",
    arguments: {},
  });
  assert.match(tabs.content[0].text, /Example/);

  const read = await mcp.handle("tools/call", {
    name: "browser_read",
    arguments: {},
  });
  assert.match(read.content[0].text, /hello world/);

  const shot = await mcp.handle("tools/call", {
    name: "browser_screenshot",
    arguments: {},
  });
  assert.equal(shot.content[1].type, "image");

  const unknown = await mcp.handle("tools/call", {
    name: "browser_nope",
    arguments: {},
  });
  assert.equal(unknown.isError, true);
});

test("relays MCP requests to a connected extension", async () => {
  const context = await startHttpRelay({
    relay: { commandTimeoutMs: 2000 },
  });
  const commands = [];
  try {
    const { socket, hello } = await connectExtension(context.wsUrl);
    assert.equal(hello.type, "hello-ok");

    socket.on("message", (raw) => {
      const message = JSON.parse(raw.toString());
      if (message.type !== "command") return;
      commands.push(message.method);
      let result = { ok: true };
      if (message.method === "tabs.list") {
        result = [
          {
            id: 4,
            active: true,
            granted: true,
            title: "Approved",
            url: "https://example.com/",
          },
        ];
      } else if (message.method === "page.read") {
        result = {
          url: "https://example.com/",
          title: "Approved",
          text: "relayed text",
          truncated: false,
        };
      }
      socket.send(
        JSON.stringify({ type: "result", id: message.id, ok: true, result }),
      );
    });

    const init = await rpc(context.base, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {},
    });
    assert.equal((await init.json()).result.serverInfo.name, "chromium-mcp");

    const tabs = await rpc(context.base, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "browser_tabs", arguments: {} },
    });
    assert.match((await tabs.json()).result.content[0].text, /Approved/);

    const read = await rpc(context.base, {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "browser_read", arguments: { tabId: 4 } },
    });
    assert.match((await read.json()).result.content[0].text, /relayed text/);

    const health = await fetch(`${context.base}/health`);
    assert.deepEqual(await health.json(), { ok: true, extension: true });

    assert.deepEqual(commands, ["tabs.list", "page.read"]);
    socket.close();
  } finally {
    await context.stop();
  }
});

test("answers application-level heartbeat pings", async () => {
  const context = await startHttpRelay();
  try {
    const { socket } = await connectExtension(context.wsUrl);
    socket.send(JSON.stringify({ type: "ping", time: 123 }));
    const pong = await waitForMessage(
      socket,
      (message) => message.type === "pong",
    );
    assert.equal(pong.time, 123);
    socket.close();
  } finally {
    await context.stop();
  }
});

test("rejects non-extension WebSocket origins", async () => {
  const context = await startHttpRelay();
  try {
    const socket = new WebSocket(context.wsUrl, {
      origin: "https://evil.example",
    });
    await assert.rejects(waitForOpen(socket), /403/);
  } finally {
    await context.stop();
  }
});

test("enforces the optional extension token", async () => {
  const context = await startHttpRelay({
    relay: { extensionToken: "ext-secret", commandTimeoutMs: 2000 },
  });
  try {
    const wrong = await connectExtension(context.wsUrl, { token: "nope" });
    assert.equal(wrong.hello.type, "hello-error");
    wrong.socket.close();

    const good = await connectExtension(context.wsUrl, {
      token: "ext-secret",
    });
    assert.equal(good.hello.type, "hello-ok");
    good.socket.close();
  } finally {
    await context.stop();
  }
});

test("enforces optional MCP bearer authentication", async () => {
  const context = await startHttpRelay({ token: "mcp-secret" });
  try {
    const unauthorized = await rpc(context.base, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {},
    });
    assert.equal(unauthorized.status, 401);
    assert.match(
      unauthorized.headers.get("www-authenticate") || "",
      /^Bearer/,
    );

    const authorized = await rpc(
      context.base,
      { jsonrpc: "2.0", id: 2, method: "initialize", params: {} },
      { Authorization: "Bearer mcp-secret" },
    );
    assert.equal(authorized.status, 200);
  } finally {
    await context.stop();
  }
});

test("reports an error when no extension is connected", async () => {
  const context = await startHttpRelay();
  try {
    const response = await rpc(context.base, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "browser_tabs", arguments: {} },
    });
    const body = await response.json();
    assert.equal(body.result.isError, true);
    assert.match(body.result.content[0].text, /not connected/i);
  } finally {
    await context.stop();
  }
});

test("creates a stdio-compatible extension-only server", async () => {
  const relay = createRelay({ commandTimeoutMs: 1000 });
  const server = createExtensionServer({ relay });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  try {
    const { socket, hello } = await connectExtension(
      `ws://127.0.0.1:${port}/extension`,
    );
    assert.equal(hello.type, "hello-ok");
    socket.close();
  } finally {
    await closeServer(server);
    await relay.close();
  }
});
