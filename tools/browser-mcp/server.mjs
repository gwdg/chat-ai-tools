#!/usr/bin/env node
// Local MCP server for headless web browsing.
// stdio keeps stdout for JSON-RPC only; HTTP binds to loopback only.

import {
  createHash,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import { realpathSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  createBrowserPool,
  createBrowserSession,
} from "./browser.mjs";

export const SERVER_INFO = { name: "browser-mcp", version: "0.1.0" };
export const PROTOCOL_VERSION = "2025-06-18";

const MAX_HTTP_BODY_BYTES = 1024 * 1024;
const LOOPBACK_HOSTS = ["127.0.0.1", "localhost", "::1", "[::1]"];
const DEFAULT_HTTP_PORT = 3922;
const DEFAULT_SESSION_IDLE_MS = 30 * 60 * 1000;
const DEFAULT_MAX_SESSIONS = 20;

const TAB_ARG = {
  type: "string",
  description:
    'Tab id from browser_tabs or browser_open. Defaults to the active tab ("active").',
};

const ELEMENT_ARGS = {
  id: {
    type: "string",
    description:
      "Element id from the most recent browser_snapshot. Preferred over selector.",
  },
  selector: {
    type: "string",
    description: "CSS selector for the target element.",
  },
  text: {
    type: "string",
    description:
      "Visible text of a link, button, input, or other interactive element (exact match preferred, then substring).",
  },
};

export const TOOLS = [
  {
    name: "browser_open",
    description:
      "Open an absolute http(s) URL in a headless Chrome tab and return the page title, final URL, tab id, and visible text. Creates the browser and first tab on demand. Only http and https are allowed.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "Absolute http:// or https:// URL." },
        tab: TAB_ARG,
        newTab: {
          type: "boolean",
          description: "Open in a new tab instead of reusing the active tab.",
        },
        waitUntil: {
          type: "string",
          enum: ["load", "domcontentloaded", "networkidle0", "networkidle2"],
          description: "Navigation wait condition. Default domcontentloaded.",
        },
        timeoutMs: {
          type: "integer",
          minimum: 1000,
          maximum: 120000,
          description: "Navigation timeout in milliseconds. Default 30000.",
        },
        includeText: {
          type: "boolean",
          description: "Include visible page text in the result. Default true.",
        },
        maxChars: {
          type: "integer",
          minimum: 1,
          maximum: 200000,
          description: "Maximum characters of page text to return. Default 20000.",
        },
      },
      required: ["url"],
      additionalProperties: false,
    },
  },
  {
    name: "browser_read",
    description:
      "Read visible text (or HTML) from the active page or a CSS-selected element. Optionally list links with their resolved URLs.",
    inputSchema: {
      type: "object",
      properties: {
        tab: TAB_ARG,
        selector: {
          type: "string",
          description: "CSS selector. Omit to read the whole page body.",
        },
        format: {
          type: "string",
          enum: ["text", "html"],
          description: "Return visible text or HTML. Default text.",
        },
        includeLinks: {
          type: "boolean",
          description: "Append up to 200 links (text and absolute href).",
        },
        maxChars: {
          type: "integer",
          minimum: 1,
          maximum: 200000,
          description: "Maximum characters to return. Default 20000.",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "browser_snapshot",
    description:
      "List the interactive elements on the page (links, buttons, inputs, selects, menu items) with a stable id, label, href, value, and disabled/checked state. Use the returned ids with browser_click and browser_type.",
    inputSchema: {
      type: "object",
      properties: {
        tab: TAB_ARG,
        maxElements: {
          type: "integer",
          minimum: 1,
          maximum: 1000,
          description: "Maximum number of elements to return. Default 200.",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "browser_click",
    description:
      "Click an element by snapshot id, CSS selector, or visible text. Scrolls it into view first and returns the resulting URL and title.",
    inputSchema: {
      type: "object",
      properties: {
        tab: TAB_ARG,
        ...ELEMENT_ARGS,
        button: {
          type: "string",
          enum: ["left", "right", "middle"],
          description: "Mouse button. Default left.",
        },
        clickCount: {
          type: "integer",
          minimum: 1,
          maximum: 3,
          description: "Number of clicks. Default 1.",
        },
        waitAfterMs: {
          type: "integer",
          minimum: 0,
          maximum: 5000,
          description: "Wait after clicking before reading the page. Default 300.",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "browser_type",
    description:
      "Focus an input, textarea, select, or contenteditable element and type text. By default the existing value is replaced. Optionally press Enter to submit.",
    inputSchema: {
      type: "object",
      properties: {
        tab: TAB_ARG,
        ...ELEMENT_ARGS,
        value: {
          type: "string",
          description: 'Text to type. Use "" together with clear to empty the field.',
        },
        clear: {
          type: "boolean",
          description: "Replace the existing value first. Default true.",
        },
        submit: {
          type: "boolean",
          description: "Press Enter after typing.",
        },
        delayMs: {
          type: "integer",
          minimum: 0,
          maximum: 1000,
          description: "Delay between keystrokes in milliseconds. Default 0.",
        },
        waitAfterMs: {
          type: "integer",
          minimum: 0,
          maximum: 5000,
          description: "Wait after typing before reading the page. Default 250.",
        },
      },
      required: ["value"],
      additionalProperties: false,
    },
  },
  {
    name: "browser_press",
    description:
      "Press a keyboard key on the active page, for example Enter, Tab, Escape, ArrowDown, PageDown, or Control+a.",
    inputSchema: {
      type: "object",
      properties: {
        tab: TAB_ARG,
        key: {
          type: "string",
          description: "Key name, for example Enter, Tab, Escape, or ArrowDown.",
        },
        times: {
          type: "integer",
          minimum: 1,
          maximum: 20,
          description: "Repeat count. Default 1.",
        },
      },
      required: ["key"],
      additionalProperties: false,
    },
  },
  {
    name: "browser_scroll",
    description:
      "Scroll the page up or down, jump to the top or bottom, or scroll a CSS-selected element into view.",
    inputSchema: {
      type: "object",
      properties: {
        tab: TAB_ARG,
        direction: {
          type: "string",
          enum: ["up", "down", "top", "bottom"],
          description: "Scroll direction. Default down.",
        },
        amount: {
          type: "integer",
          minimum: 1,
          maximum: 20000,
          description: "Pixels to scroll for up/down. Default 600.",
        },
        selector: {
          type: "string",
          description: "Scroll this element into view instead of scrolling by direction.",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "browser_wait_for",
    description:
      "Wait until a CSS selector reaches a state or until the page text contains a string. Useful after clicking or typing.",
    inputSchema: {
      type: "object",
      properties: {
        tab: TAB_ARG,
        selector: { type: "string", description: "CSS selector to wait for." },
        text: {
          type: "string",
          description: "Case-insensitive text to wait for in the page body.",
        },
        state: {
          type: "string",
          enum: ["attached", "detached", "visible", "hidden"],
          description: "Selector state to wait for. Default visible.",
        },
        timeoutMs: {
          type: "integer",
          minimum: 1000,
          maximum: 120000,
          description: "Timeout in milliseconds. Default 30000.",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "browser_evaluate",
    description:
      "Evaluate a JavaScript expression inside the page and return its JSON value. Runs in the page context, not Node. Use an async IIFE for statements or top-level await.",
    inputSchema: {
      type: "object",
      properties: {
        tab: TAB_ARG,
        expression: {
          type: "string",
          description:
            'JavaScript expression, for example document.title or (async () => (await fetch("/api")).status)().',
        },
      },
      required: ["expression"],
      additionalProperties: false,
    },
  },
  {
    name: "browser_screenshot",
    description:
      "Capture the visible viewport or the full page as a PNG or JPEG image.",
    inputSchema: {
      type: "object",
      properties: {
        tab: TAB_ARG,
        fullPage: {
          type: "boolean",
          description: "Capture the full scrollable page. Default false.",
        },
        format: {
          type: "string",
          enum: ["png", "jpeg"],
          description: "Image format. Default png.",
        },
        quality: {
          type: "integer",
          minimum: 1,
          maximum: 100,
          description: "JPEG quality. Default 80.",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "browser_tabs",
    description: "List open tabs with their id, title, URL, and active marker.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: "browser_switch_tab",
    description: "Make an open tab the active tab.",
    inputSchema: {
      type: "object",
      properties: { tab: TAB_ARG },
      required: ["tab"],
      additionalProperties: false,
    },
  },
  {
    name: "browser_close_tab",
    description: "Close one tab. The browser stays running.",
    inputSchema: {
      type: "object",
      properties: { tab: TAB_ARG },
      required: ["tab"],
      additionalProperties: false,
    },
  },
  {
    name: "browser_history",
    description: "Go back, go forward, or reload the active tab.",
    inputSchema: {
      type: "object",
      properties: {
        tab: TAB_ARG,
        action: {
          type: "string",
          enum: ["back", "forward", "reload"],
          description: "History action. Default back.",
        },
        timeoutMs: {
          type: "integer",
          minimum: 1000,
          maximum: 120000,
          description: "Timeout in milliseconds. Default 30000.",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "browser_close",
    description:
      "Close the headless browser and all tabs. The next browser_open launches a fresh browser.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
];

const TOOL_NAMES = new Set(TOOLS.map((tool) => tool.name));

function textResult(text) {
  return { content: [{ type: "text", text }] };
}

function errorResult(text) {
  return { content: [{ type: "text", text }], isError: true };
}

function resolveCorsOrigins(value) {
  return String(value || "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
}

function isOriginAllowed(origin, corsOrigins) {
  if (!origin) return false;
  if (corsOrigins.includes("*")) return true;
  if (corsOrigins.length) return corsOrigins.includes(origin);

  try {
    const { hostname } = new URL(origin);
    return ["127.0.0.1", "localhost", "[::1]"].includes(hostname);
  } catch {
    return false;
  }
}

function setHttpCors(req, res, corsOrigins) {
  const origin = req.headers.origin;
  if (isOriginAllowed(origin, corsOrigins)) {
    res.setHeader(
      "Access-Control-Allow-Origin",
      corsOrigins.includes("*") ? "*" : origin,
    );
    res.setHeader("Vary", "Origin");
  }

  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Accept, Authorization, Mcp-Session-Id, Mcp-Protocol-Version, Last-Event-ID",
  );
  res.setHeader("Access-Control-Expose-Headers", "Mcp-Session-Id");
  res.setHeader("Access-Control-Max-Age", "600");

  if (req.headers["access-control-request-private-network"] === "true") {
    res.setHeader("Access-Control-Allow-Private-Network", "true");
  }
}

function sendJson(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;

    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_HTTP_BODY_BYTES) {
        reject(new Error("Request body is too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function sessionHeader(req) {
  const value = req.headers["mcp-session-id"];
  return Array.isArray(value) ? value[0] : value;
}

export function createSessionManager({
  sessionFactory = () => createBrowserSession(),
  idleTimeoutMs = DEFAULT_SESSION_IDLE_MS,
  maxSessions = DEFAULT_MAX_SESSIONS,
} = {}) {
  const sessions = new Map();
  let defaultId = null;

  async function remove(id) {
    const entry = sessions.get(id);
    if (!entry) return false;
    sessions.delete(id);
    if (defaultId === id) defaultId = null;
    try {
      await entry.session.close();
    } catch {
      // Ignore shutdown errors.
    }
    return true;
  }

  async function evictOldest() {
    const candidate = [...sessions.values()]
      .filter((entry) => !entry.isDefault)
      .sort((a, b) => a.lastUsed - b.lastUsed)[0];
    if (!candidate) return false;
    await remove(candidate.id);
    return true;
  }

  async function create({ isDefault = false } = {}) {
    if (sessions.size >= maxSessions && !(await evictOldest())) {
      const error = new Error(
        `Too many browser sessions (limit ${maxSessions}). Close a session or raise MCP_BROWSER_MAX_SESSIONS.`,
      );
      error.statusCode = 429;
      throw error;
    }

    const id = randomUUID();
    const session = sessionFactory();
    const entry = {
      id,
      session,
      server: createBrowserServer({ session }),
      lastUsed: Date.now(),
      isDefault,
    };
    sessions.set(id, entry);
    if (isDefault) defaultId = id;
    return entry;
  }

  function get(id) {
    return id ? sessions.get(id) : undefined;
  }

  function touch(id) {
    const entry = sessions.get(id);
    if (entry) entry.lastUsed = Date.now();
  }

  function getDefault() {
    if (defaultId) {
      const entry = sessions.get(defaultId);
      if (entry) return entry;
      defaultId = null;
    }
    return create({ isDefault: true });
  }

  async function removeDefault() {
    if (!defaultId) return false;
    return remove(defaultId);
  }

  async function sweep(now = Date.now()) {
    if (!(idleTimeoutMs > 0)) return 0;
    let removed = 0;
    for (const entry of [...sessions.values()]) {
      if (now - entry.lastUsed >= idleTimeoutMs) {
        if (await remove(entry.id)) removed += 1;
      }
    }
    return removed;
  }

  async function closeAll() {
    for (const id of [...sessions.keys()]) {
      await remove(id);
    }
  }

  return {
    create,
    get,
    getDefault,
    touch,
    remove,
    removeDefault,
    sweep,
    closeAll,
    get size() {
      return sessions.size;
    },
    get defaultId() {
      return defaultId;
    },
  };
}

function bearerTokenMatches(req, expected) {
  const header = req.headers.authorization;
  if (typeof header !== "string") return false;
  const match = header.match(/^Bearer\s+(.+)$/i);
  if (!match) return false;
  const provided = createHash("sha256").update(match[1].trim()).digest();
  const wanted = createHash("sha256").update(expected).digest();
  return timingSafeEqual(provided, wanted);
}

export function createHttpServer({
  sessionManager,
  corsOrigins,
  token = "",
} = {}) {
  if (!sessionManager || typeof sessionManager.create !== "function") {
    throw new Error("createHttpServer needs a session manager");
  }

  const bearerToken = typeof token === "string" ? token.trim() : "";
  const origins =
    corsOrigins ??
    resolveCorsOrigins(process.env.MCP_BROWSER_CORS_ORIGIN || "");

  return http.createServer(async (req, res) => {
    const url = new URL(
      req.url || "/",
      `http://${req.headers.host || "127.0.0.1"}`,
    );
    setHttpCors(req, res, origins);

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    if (req.method === "GET" && url.pathname === "/health") {
      sendJson(res, 200, { ok: true });
      return;
    }

    if (url.pathname !== "/mcp") {
      sendJson(res, 404, { error: "Not found" });
      return;
    }

    if (bearerToken && !bearerTokenMatches(req, bearerToken)) {
      res.setHeader("WWW-Authenticate", 'Bearer realm="browser-mcp"');
      res.setHeader("Cache-Control", "no-store");
      sendJson(res, 401, { error: "Unauthorized" });
      return;
    }

    if (req.method === "GET") {
      res.writeHead(405, { Allow: "POST, DELETE, OPTIONS" });
      res.end();
      return;
    }

    if (req.method === "DELETE") {
      const sessionId = sessionHeader(req);
      if (sessionId) {
        const removed = await sessionManager.remove(sessionId);
        res.writeHead(removed ? 204 : 404);
      } else {
        await sessionManager.removeDefault();
        res.writeHead(204);
      }
      res.end();
      return;
    }

    if (req.method !== "POST") {
      res.writeHead(405, { Allow: "POST, DELETE, OPTIONS" });
      res.end();
      return;
    }

    let rawBody;
    try {
      rawBody = await readRequestBody(req);
    } catch (error) {
      sendJson(res, 413, { error: error.message });
      return;
    }

    let message;
    try {
      message = JSON.parse(rawBody.toString("utf8"));
    } catch {
      sendJson(res, 400, {
        jsonrpc: "2.0",
        id: null,
        error: { code: -32700, message: "Parse error" },
      });
      return;
    }

    if (
      !message ||
      message.jsonrpc !== "2.0" ||
      typeof message.method !== "string"
    ) {
      sendJson(res, 400, {
        jsonrpc: "2.0",
        id: message?.id ?? null,
        error: { code: -32600, message: "Invalid Request" },
      });
      return;
    }

    const sessionId = sessionHeader(req);

    if (message.id === undefined) {
      if (sessionId) sessionManager.touch(sessionId);
      res.writeHead(202);
      res.end();
      return;
    }

    let entry;
    try {
      if (message.method === "initialize" && !sessionId) {
        entry = await sessionManager.create();
      } else if (sessionId) {
        entry = sessionManager.get(sessionId);
        if (!entry) {
          sendJson(res, 404, {
            jsonrpc: "2.0",
            id: message.id,
            error: { code: -32001, message: "Session not found" },
          });
          return;
        }
      } else {
        entry = await sessionManager.getDefault();
      }
    } catch (error) {
      sendJson(
        res,
        Number.isFinite(error?.statusCode) ? error.statusCode : 500,
        {
          jsonrpc: "2.0",
          id: message.id,
          error: {
            code: -32000,
            message: error?.message || String(error),
          },
        },
      );
      return;
    }

    sessionManager.touch(entry.id);
    res.setHeader("Mcp-Session-Id", entry.id);

    try {
      const result = await entry.server.handle(
        message.method,
        message.params || {},
      );
      sendJson(res, 200, {
        jsonrpc: "2.0",
        id: message.id,
        result,
      });
    } catch (error) {
      sendJson(res, 200, {
        jsonrpc: "2.0",
        id: message.id,
        error: {
          code: Number.isFinite(error?.code) ? error.code : -32603,
          message: error?.message || String(error),
        },
      });
    }
  });
}

export function createBrowserServer({ session } = {}) {
  if (!session || typeof session.call !== "function") {
    throw new Error("createBrowserServer needs a browser session");
  }

  async function callTool(name, args) {
    if (!TOOL_NAMES.has(name)) {
      return errorResult(`Unknown tool: ${name}`);
    }

    try {
      return await session.call(name, args);
    } catch (error) {
      return errorResult(error?.message || String(error));
    }
  }

  return {
    session,
    async handle(method, params = {}) {
      switch (method) {
        case "initialize":
          return {
            protocolVersion: params.protocolVersion || PROTOCOL_VERSION,
            capabilities: { tools: {} },
            serverInfo: SERVER_INFO,
            instructions:
              "Local headless Chrome for web access. Open http(s) pages, read them, snapshots interactive elements, then click or type by snapshot id, selector, or visible text. Only http and https are allowed. Install Chrome/Chromium and set BROWSER_MCP_CHROME_PATH if it is not auto-detected.",
          };
        case "ping":
          return {};
        case "tools/list":
          return { tools: TOOLS };
        case "tools/call":
          return callTool(
            params?.name,
            params?.arguments && typeof params.arguments === "object"
              ? params.arguments
              : {},
          );
        default: {
          const error = new Error(`Method not found: ${method}`);
          error.code = -32601;
          throw error;
        }
      }
    },
  };
}

function mainStdio() {
  const session = createBrowserSession();
  const server = createBrowserServer({ session });

  process.stdin.setEncoding("utf8");
  let buffer = "";
  let queue = Promise.resolve();

  const send = (message) => {
    process.stdout.write(`${JSON.stringify(message)}\n`);
  };

  const handleLine = async (line) => {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      send({
        jsonrpc: "2.0",
        id: null,
        error: { code: -32700, message: "Parse error" },
      });
      return;
    }

    if (
      !message ||
      message.jsonrpc !== "2.0" ||
      typeof message.method !== "string"
    ) {
      if (message?.id !== undefined) {
        send({
          jsonrpc: "2.0",
          id: message.id,
          error: { code: -32600, message: "Invalid Request" },
        });
      }
      return;
    }

    if (message.id === undefined) return;

    try {
      const result = await server.handle(message.method, message.params || {});
      if (result !== undefined) {
        send({ jsonrpc: "2.0", id: message.id, result });
      }
    } catch (error) {
      send({
        jsonrpc: "2.0",
        id: message.id,
        error: {
          code: Number.isFinite(error?.code) ? error.code : -32603,
          message: error?.message || String(error),
        },
      });
    }
  };

  process.stdin.on("data", (chunk) => {
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      queue = queue.then(() => handleLine(line)).catch((error) => {
        console.error(`browser-mcp: ${error?.message || error}`);
      });
    }
  });

  process.stdin.on("end", () => {
    queue.finally(() => {
      session.close().finally(() => process.exit(0));
    });
  });

  process.stdout.on("error", () => process.exit(0));
  process.stdin.on("error", () => process.exit(0));

  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, () => {
      session.close().finally(() => process.exit(0));
    });
  }

  console.error(
    "browser-mcp ready (stdio). Chrome starts on the first browser_open call.",
  );
}

function mainHttp() {
  const requestedHost = process.env.HOST || "127.0.0.1";
  if (!LOOPBACK_HOSTS.includes(requestedHost)) {
    console.error(
      `Refusing to listen on ${requestedHost}: browser-mcp only binds to loopback (${LOOPBACK_HOSTS.join(", ")}).`,
    );
    process.exit(1);
  }
  const host = requestedHost === "[::1]" ? "::1" : requestedHost;

  const requestedIdle = Number(
    process.env.MCP_BROWSER_SESSION_IDLE_MS || DEFAULT_SESSION_IDLE_MS,
  );
  const idleTimeoutMs =
    Number.isFinite(requestedIdle) && requestedIdle >= 0
      ? requestedIdle
      : DEFAULT_SESSION_IDLE_MS;
  const requestedMax = Number.parseInt(
    process.env.MCP_BROWSER_MAX_SESSIONS,
    10,
  );
  const maxSessions =
    Number.isInteger(requestedMax) && requestedMax > 0
      ? requestedMax
      : DEFAULT_MAX_SESSIONS;

  const pool = createBrowserPool();
  const sessionManager = createSessionManager({
    sessionFactory: () =>
      createBrowserSession({
        browserProvider: () => pool.getBrowser(),
        isolate: !process.env.BROWSER_MCP_USER_DATA_DIR,
      }),
    idleTimeoutMs,
    maxSessions,
  });
  const corsOrigins = resolveCorsOrigins(
    process.env.MCP_BROWSER_CORS_ORIGIN || "",
  );
  const token = (process.env.MCP_BROWSER_TOKEN || "").trim();
  const httpServer = createHttpServer({
    sessionManager,
    corsOrigins,
    token,
  });

  let sweepTimer = null;
  if (idleTimeoutMs > 0) {
    const interval = Math.max(
      1_000,
      Math.min(60_000, Math.floor(idleTimeoutMs / 2)),
    );
    sweepTimer = setInterval(() => {
      sessionManager.sweep().catch((error) => {
        console.error(
          `browser-mcp session sweep failed: ${error?.message || error}`,
        );
      });
    }, interval);
    sweepTimer.unref?.();
  }

  const requestedPort = Number(process.env.MCP_BROWSER_HTTP_PORT || DEFAULT_HTTP_PORT);
  const port =
    Number.isInteger(requestedPort) &&
    requestedPort >= 0 &&
    requestedPort <= 65535
      ? requestedPort
      : DEFAULT_HTTP_PORT;

  httpServer.on("error", (error) => {
    console.error(`browser-mcp HTTP server error: ${error.message}`);
    process.exit(1);
  });

  httpServer.listen(port, host, () => {
    const address = httpServer.address();
    const actualPort =
      typeof address === "object" && address ? address.port : port;
    const displayHost = host === "::1" ? "[::1]" : host;

    console.log(
      `browser-mcp HTTP server listening on ${displayHost}:${actualPort}`,
    );
    console.log("Use the following MCP endpoint in Chat AI:");
    console.log(`http://${displayHost}:${actualPort}/mcp`);
    console.log(
      corsOrigins.length
        ? `CORS origins: ${corsOrigins.join(", ")}`
        : "CORS origins: localhost/127.0.0.1 only",
    );
    console.log(
      token
        ? "Authentication: Bearer token required"
        : "Authentication: disabled (set MCP_BROWSER_TOKEN to require a Bearer token)",
    );
    const idleLabel =
      idleTimeoutMs > 0 ? `${Math.round(idleTimeoutMs / 1000)}s` : "disabled";
    console.log(
      process.env.BROWSER_MCP_USER_DATA_DIR
        ? `MCP sessions: separate tabs on one persistent profile (idle ${idleLabel}, max ${maxSessions})`
        : `MCP sessions: isolated browser contexts per session (idle ${idleLabel}, max ${maxSessions})`,
    );
  });

  let shuttingDown = false;
  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    if (sweepTimer) clearInterval(sweepTimer);
    httpServer.close(() => {
      sessionManager
        .closeAll()
        .finally(() => pool.close())
        .finally(() => process.exit(0));
    });
  };

  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, shutdown);
  }
}

function main() {
  const useHttp =
    process.argv.includes("--http") ||
    process.env.MCP_BROWSER_TRANSPORT === "http";

  if (useHttp) {
    mainHttp();
    return;
  }

  mainStdio();
}

function isMainModule() {
  if (!process.argv[1]) return false;
  try {
    return (
      realpathSync(path.resolve(process.argv[1])) ===
      realpathSync(fileURLToPath(import.meta.url))
    );
  } catch {
    return false;
  }
}

if (process.env.MCP_SEA === "1") main();
else if (isMainModule()) main();
