import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import http from "node:http";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  clampInteger,
  createBrowserSession,
  isBrowserAvailable,
  normalizeNavigationUrl,
  parseAllowedHosts,
} from "../tools/browser-mcp/browser.mjs";
import {
  chromeUserAgent,
  platformToken,
  typingSchedule,
} from "../tools/browser-mcp/humanize.mjs";
import {
  createBrowserServer,
  createHttpServer,
  createSessionManager,
} from "../tools/browser-mcp/server.mjs";

const EXPECTED_TOOLS = [
  "browser_open",
  "browser_read",
  "browser_snapshot",
  "browser_click",
  "browser_type",
  "browser_press",
  "browser_scroll",
  "browser_wait_for",
  "browser_evaluate",
  "browser_screenshot",
  "browser_tabs",
  "browser_switch_tab",
  "browser_close_tab",
  "browser_history",
  "browser_close",
];

test("normalizes and validates navigation URLs", () => {
  assert.equal(
    normalizeNavigationUrl(" https://example.com/a?b=1 "),
    "https://example.com/a?b=1",
  );
  assert.equal(
    normalizeNavigationUrl("http://127.0.0.1:8080/test"),
    "http://127.0.0.1:8080/test",
  );

  for (const blocked of [
    "file:///etc/passwd",
    "javascript:alert(1)",
    "data:text/html,hi",
    "ftp://example.com/file",
    "example.com",
  ]) {
    assert.throws(() => normalizeNavigationUrl(blocked), /http|scheme|Invalid URL/i);
  }
});

test("enforces optional host allowlists", () => {
  const allowedHosts = parseAllowedHosts("example.com, internal.test");
  assert.deepEqual(allowedHosts, ["example.com", "internal.test"]);
  assert.equal(
    normalizeNavigationUrl("https://docs.example.com/x", { allowedHosts }),
    "https://docs.example.com/x",
  );
  assert.throws(
    () => normalizeNavigationUrl("https://evil.test/", { allowedHosts }),
    /not in BROWSER_MCP_ALLOWED_HOSTS/,
  );
});

test("clamps numeric arguments", () => {
  assert.equal(clampInteger(undefined, 10, 1, 20), 10);
  assert.equal(clampInteger("99", 10, 1, 20), 20);
  assert.equal(clampInteger("-5", 10, 1, 20), 1);
  assert.equal(clampInteger("nope", 10, 1, 20), 10);
});

test("builds a non-headless user agent and human typing delays", () => {
  assert.equal(platformToken("linux"), "X11; Linux x86_64");
  assert.match(platformToken("win32"), /Windows NT/);
  assert.match(platformToken("darwin"), /Macintosh/);

  const userAgent = chromeUserAgent(
    "HeadlessChrome/156.0.6533.119",
    "linux",
  );
  assert.equal(
    userAgent,
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.6533.119 Safari/537.36",
  );
  assert.doesNotMatch(userAgent, /Headless/);

  const zero = () => 0;
  assert.deepEqual(
    typingSchedule("abc", {
      minDelay: 10,
      maxDelay: 20,
      pauseChance: 0,
      random: zero,
    }),
    [10, 10, 10],
  );

  const almostOne = () => 0.999;
  assert.deepEqual(
    typingSchedule("a", {
      minDelay: 10,
      maxDelay: 20,
      pauseChance: 0,
      random: almostOne,
    }),
    [20],
  );

  const sequence = [0, 0, 0, 1];
  let index = 0;
  const stepped = () => sequence[Math.min(index++, sequence.length - 1)];
  assert.deepEqual(
    typingSchedule("a", {
      minDelay: 10,
      maxDelay: 10,
      pauseChance: 1,
      pauseMin: 100,
      pauseMax: 200,
      random: stepped,
    }),
    [110],
  );
});

test("browser server advertises its tools and handles calls", async () => {
  const calls = [];
  const session = {
    async call(name, args) {
      calls.push({ name, args });
      return { content: [{ type: "text", text: `ok:${name}` }] };
    },
  };
  const server = createBrowserServer({ session });

  const init = await server.handle("initialize", {
    protocolVersion: "2025-06-18",
  });
  assert.equal(init.serverInfo.name, "browser-mcp");
  assert.equal(init.capabilities.tools !== undefined, true);

  const list = await server.handle("tools/list", {});
  assert.deepEqual(
    list.tools.map((tool) => tool.name),
    EXPECTED_TOOLS,
  );

  const called = await server.handle("tools/call", {
    name: "browser_read",
    arguments: { maxChars: 100 },
  });
  assert.equal(called.content[0].text, "ok:browser_read");
  assert.deepEqual(calls[0], {
    name: "browser_read",
    args: { maxChars: 100 },
  });

  const unknown = await server.handle("tools/call", {
    name: "browser_nope",
    arguments: {},
  });
  assert.equal(unknown.isError, true);
  assert.match(unknown.content[0].text, /Unknown tool/);

  const failing = createBrowserServer({
    session: {
      async call() {
        throw new Error("boom");
      },
    },
  });
  const failed = await failing.handle("tools/call", {
    name: "browser_open",
    arguments: { url: "https://example.com" },
  });
  assert.equal(failed.isError, true);
  assert.match(failed.content[0].text, /boom/);

  await assert.rejects(
    () => server.handle("nope", {}),
    /Method not found/,
  );
});

test("refuses a non-loopback HTTP bind address", () => {
  const serverPath = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../tools/browser-mcp/server.mjs",
  );
  const result = spawnSync(process.execPath, [serverPath, "--http"], {
    env: { ...process.env, HOST: "0.0.0.0" },
    encoding: "utf8",
    timeout: 10_000,
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Refusing to listen/);
});

test("serves isolated MCP sessions over HTTP", async () => {
  const calls = [];
  const closed = [];
  let sessionNumber = 0;
  const sessionManager = createSessionManager({
    sessionFactory: () => {
      const number = ++sessionNumber;
      return {
        async call(name) {
          calls.push({ number, name });
          return {
            content: [{ type: "text", text: `session-${number}:${name}` }],
          };
        },
        async close() {
          closed.push(number);
        },
      };
    },
    idleTimeoutMs: 60_000,
    maxSessions: 4,
  });
  const httpServer = createHttpServer({ sessionManager, corsOrigins: [] });
  await new Promise((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
  const { port } = httpServer.address();
  const base = `http://127.0.0.1:${port}`;

  const rpc = (body, sessionId, origin) =>
    fetch(`${base}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(origin ? { Origin: origin } : {}),
        ...(sessionId ? { "Mcp-Session-Id": sessionId } : {}),
      },
      body: JSON.stringify(body),
    });

  try {
    const initA = await rpc(
      { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
      undefined,
      "http://127.0.0.1:8080",
    );
    assert.equal(initA.status, 200);
    assert.equal(
      initA.headers.get("access-control-allow-origin"),
      "http://127.0.0.1:8080",
    );
    const sessionA = initA.headers.get("mcp-session-id");
    assert.ok(sessionA);
    assert.equal((await initA.json()).result.serverInfo.name, "browser-mcp");

    const initB = await rpc({
      jsonrpc: "2.0",
      id: 2,
      method: "initialize",
      params: {},
    });
    const sessionB = initB.headers.get("mcp-session-id");
    assert.ok(sessionB);
    assert.notEqual(sessionA, sessionB);

    const callA = await rpc(
      {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "browser_read", arguments: {} },
      },
      sessionA,
    );
    assert.match(
      (await callA.json()).result.content[0].text,
      /session-1:browser_read/,
    );

    const callB = await rpc(
      {
        jsonrpc: "2.0",
        id: 4,
        method: "tools/call",
        params: { name: "browser_read", arguments: {} },
      },
      sessionB,
    );
    assert.match(
      (await callB.json()).result.content[0].text,
      /session-2:browser_read/,
    );
    assert.deepEqual(calls, [
      { number: 1, name: "browser_read" },
      { number: 2, name: "browser_read" },
    ]);

    const unknown = await rpc(
      {
        jsonrpc: "2.0",
        id: 5,
        method: "tools/list",
        params: {},
      },
      "does-not-exist",
    );
    assert.equal(unknown.status, 404);

    const notification = await rpc(
      { jsonrpc: "2.0", method: "notifications/initialized" },
      sessionA,
    );
    assert.equal(notification.status, 202);

    const deleted = await fetch(`${base}/mcp`, {
      method: "DELETE",
      headers: { "Mcp-Session-Id": sessionA },
    });
    assert.equal(deleted.status, 204);
    assert.deepEqual(closed, [1]);
    const afterDelete = await rpc(
      {
        jsonrpc: "2.0",
        id: 6,
        method: "tools/list",
        params: {},
      },
      sessionA,
    );
    assert.equal(afterDelete.status, 404);

    const headerless = await rpc({
      jsonrpc: "2.0",
      id: 7,
      method: "tools/list",
      params: {},
    });
    assert.equal(headerless.status, 200);
    assert.ok(headerless.headers.get("mcp-session-id"));

    const health = await fetch(`${base}/health`);
    assert.deepEqual(await health.json(), { ok: true });

    const blocked = await fetch(`${base}/mcp`, {
      method: "OPTIONS",
      headers: { Origin: "http://evil.example" },
    });
    assert.equal(blocked.status, 204);
    assert.equal(blocked.headers.get("access-control-allow-origin"), null);

    const stream = await fetch(`${base}/mcp`, { method: "GET" });
    assert.equal(stream.status, 405);
  } finally {
    await new Promise((resolve) => httpServer.close(resolve));
    await sessionManager.closeAll();
  }
});

test("requires a bearer token when configured", async () => {
  const sessionManager = createSessionManager({
    sessionFactory: () => ({
      async call() {
        return { content: [{ type: "text", text: "ok" }] };
      },
      async close() {},
    }),
  });
  const httpServer = createHttpServer({
    sessionManager,
    corsOrigins: [],
    token: "s3cret",
  });
  await new Promise((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
  const { port } = httpServer.address();
  const base = `http://127.0.0.1:${port}`;

  const initialize = (authorization) =>
    fetch(`${base}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(authorization ? { Authorization: authorization } : {}),
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {},
      }),
    });

  try {
    const missing = await initialize();
    assert.equal(missing.status, 401);
    assert.match(missing.headers.get("www-authenticate") || "", /^Bearer/);
    assert.equal((await missing.json()).error, "Unauthorized");

    const wrong = await initialize("Bearer nope");
    assert.equal(wrong.status, 401);

    const basic = await initialize("Basic s3cret");
    assert.equal(basic.status, 401);

    const good = await initialize("bearer s3cret");
    assert.equal(good.status, 200);
    const sessionId = good.headers.get("mcp-session-id");
    assert.ok(sessionId);

    const list = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer s3cret",
        "Mcp-Session-Id": sessionId,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
    });
    assert.equal(list.status, 200);

    const health = await fetch(`${base}/health`);
    assert.equal(health.status, 200);

    const preflight = await fetch(`${base}/mcp`, {
      method: "OPTIONS",
      headers: { Origin: "http://127.0.0.1:8080" },
    });
    assert.equal(preflight.status, 204);

    const unauthorizedDelete = await fetch(`${base}/mcp`, {
      method: "DELETE",
      headers: { "Mcp-Session-Id": sessionId },
    });
    assert.equal(unauthorizedDelete.status, 401);

    const deleted = await fetch(`${base}/mcp`, {
      method: "DELETE",
      headers: {
        Authorization: "Bearer s3cret",
        "Mcp-Session-Id": sessionId,
      },
    });
    assert.equal(deleted.status, 204);
  } finally {
    await new Promise((resolve) => httpServer.close(resolve));
    await sessionManager.closeAll();
  }
});

test("expires idle sessions and evicts the oldest at the limit", async () => {
  const closed = [];
  const factory = () => ({
    async call() {},
    async close() {
      closed.push(true);
    },
  });

  const idleManager = createSessionManager({
    sessionFactory: factory,
    idleTimeoutMs: 1_000,
    maxSessions: 10,
  });
  const idle = await idleManager.create();
  assert.equal(await idleManager.sweep(idle.lastUsed + 500), 0);
  assert.equal(await idleManager.sweep(idle.lastUsed + 2_000), 1);
  assert.equal(idleManager.size, 0);

  const cappedManager = createSessionManager({
    sessionFactory: factory,
    idleTimeoutMs: 60_000,
    maxSessions: 2,
  });
  const first = await cappedManager.create();
  const second = await cappedManager.create();
  first.lastUsed = 1;
  second.lastUsed = 2;
  await cappedManager.create();
  assert.equal(cappedManager.size, 2);
  assert.equal(cappedManager.get(first.id), undefined);
  assert.ok(cappedManager.get(second.id));
  assert.equal(closed.length, 2);
});

test("drives a real headless Chrome end to end", async (t) => {
  if (!(await isBrowserAvailable())) {
    t.skip("puppeteer-core or Chrome is not installed");
    return;
  }

  const page = `<!doctype html>
<html><head><title>Browser MCP Test</title></head><body>
<h1>Hello</h1>
<button id="change" onclick="document.getElementById('out').textContent='clicked'">Press me</button>
<input id="name" placeholder="Your name" />
<button id="submit" onclick="document.getElementById('out').textContent='hi '+document.getElementById('name').value">Say hi</button>
<p id="out">initial</p>
<a href="/second">Second page</a>
</body></html>`;

  const web = http.createServer((req, res) => {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.end(
      req.url === "/second"
        ? "<title>Second</title><p>second page</p>"
        : page,
    );
  });
  await new Promise((resolve) => web.listen(0, "127.0.0.1", resolve));
  const { port } = web.address();
  const origin = `http://127.0.0.1:${port}`;

  const session = createBrowserSession();
  const text = (result) =>
    result.content
      .filter((item) => item.type === "text")
      .map((item) => item.text)
      .join("\n");

  try {
    const opened = await session.call("browser_open", { url: `${origin}/` });
    assert.match(text(opened), /Title: Browser MCP Test/);

    const userAgent = text(
      await session.call("browser_evaluate", {
        expression: "navigator.userAgent",
      }),
    );
    assert.doesNotMatch(userAgent, /Headless/);
    assert.match(userAgent, /Chrome\//);
    const webdriver = text(
      await session.call("browser_evaluate", {
        expression: "String(navigator.webdriver)",
      }),
    );
    assert.match(webdriver, /undefined/);

    const snapshot = await session.call("browser_snapshot", {});
    const snapshotText = text(snapshot);
    assert.match(snapshotText, /"name": "Press me"/);
    const inputId = snapshotText.match(
      /"id": "(\d+)",\s*\n\s*"tag": "input"/,
    )?.[1];
    assert.ok(inputId, "snapshot should contain the input id");

    await session.call("browser_click", { text: "Press me" });
    assert.match(
      text(await session.call("browser_read", {})),
      /clicked/,
    );

    await session.call("browser_type", {
      id: inputId,
      value: "Ada",
    });
    await session.call("browser_click", { text: "Say hi" });
    assert.match(
      text(await session.call("browser_read", {})),
      /hi Ada/,
    );

    await session.call("browser_click", { text: "Second page" });
    assert.match(
      text(await session.call("browser_read", {})),
      /second page/,
    );

    await session.call("browser_history", { action: "back" });
    assert.match(text(await session.call("browser_read", {})), /Hello/);

    const shot = await session.call("browser_screenshot", {});
    const image = shot.content.find((item) => item.type === "image");
    assert.equal(image.mimeType, "image/png");
    assert.ok(image.data.length > 100);

    assert.match(text(await session.call("browser_tabs", {})), /tab-1/);
    await session.call("browser_close", {});
    assert.equal(session.tabCount, 0);
  } finally {
    await session.close();
    await new Promise((resolve) => web.close(resolve));
  }
});
