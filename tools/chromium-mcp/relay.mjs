#!/usr/bin/env node
// Local MCP relay for the Chromium browser-control extension.
// MCP clients talk HTTP (or stdio); the extension talks WebSocket.

import {
  createHash,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import { realpathSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { WebSocketServer } from "ws";

import { normalizeNavigationUrl } from "./extension/permissions.js";

export const SERVER_INFO = { name: "chromium-mcp", version: "0.1.0" };
export const PROTOCOL_VERSION = "2025-06-18";

const MAX_HTTP_BODY_BYTES = 1024 * 1024;
const LOOPBACK_HOSTS = ["127.0.0.1", "localhost", "::1", "[::1]"];
const DEFAULT_HTTP_PORT = 8766;
const DEFAULT_COMMAND_TIMEOUT_MS = 180_000;

const TAB_ARG = {
  type: "integer",
  description:
    "Tab id from browser_tabs. Defaults to the active tab. The user must approve access.",
};

const ELEMENT_ARGS = {
  id: {
    type: "string",
    description: "Element id from the most recent browser_snapshot.",
  },
  selector: {
    type: "string",
    description: "CSS selector for the target element.",
  },
  text: {
    type: "string",
    description: "Visible text of the target element.",
  },
};

export const TOOLS = [
  {
    name: "browser_status",
    description:
      "Report whether the Chromium extension is connected to the local relay.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: "browser_tabs",
    description:
      "List browser tabs. Titles and URLs are shown only for tabs the user has already approved for this session; other tabs show only their id.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: "browser_open",
    description:
      "Open an http(s) URL in a new tab, or navigate an existing tab. The user must approve access to the tab in a confirmation window.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "Absolute http:// or https:// URL." },
        tabId: TAB_ARG,
        newTab: {
          type: "boolean",
          description:
            "Create a new tab. Default true when tabId is omitted; false reuses the active tab.",
        },
        timeoutMs: {
          type: "integer",
          minimum: 1000,
          maximum: 120000,
          description: "Navigation timeout. Default 30000.",
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
      "Read visible text or HTML from a tab, optionally from one CSS selector, with optional links. Requires user approval for the tab.",
    inputSchema: {
      type: "object",
      properties: {
        tabId: TAB_ARG,
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
          description: "Append up to 200 links with absolute URLs.",
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
      "List interactive elements on an approved tab (links, buttons, inputs, selects) with ids for browser_click and browser_type.",
    inputSchema: {
      type: "object",
      properties: {
        tabId: TAB_ARG,
        maxElements: {
          type: "integer",
          minimum: 1,
          maximum: 1000,
          description: "Maximum number of elements. Default 200.",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "browser_click",
    description:
      "Click an element on an approved tab by snapshot id, CSS selector, or visible text.",
    inputSchema: {
      type: "object",
      properties: {
        tabId: TAB_ARG,
        ...ELEMENT_ARGS,
      },
      additionalProperties: false,
    },
  },
  {
    name: "browser_type",
    description:
      "Focus an input, textarea, select, or contenteditable element on an approved tab and enter text, optionally submitting with Enter.",
    inputSchema: {
      type: "object",
      properties: {
        tabId: TAB_ARG,
        ...ELEMENT_ARGS,
        value: {
          type: "string",
          description: 'Text to enter. Use "" with clear to empty the field.',
        },
        clear: {
          type: "boolean",
          description: "Replace the existing value first. Default true.",
        },
        submit: {
          type: "boolean",
          description: "Press Enter after typing.",
        },
      },
      required: ["value"],
      additionalProperties: false,
    },
  },
  {
    name: "browser_press",
    description:
      "Send a keyboard key to the focused element on an approved tab.",
    inputSchema: {
      type: "object",
      properties: {
        tabId: TAB_ARG,
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
      "Scroll an approved tab up or down, jump to the top or bottom, or bring an element into view.",
    inputSchema: {
      type: "object",
      properties: {
        tabId: TAB_ARG,
        direction: {
          type: "string",
          enum: ["up", "down", "top", "bottom"],
          description: "Scroll direction. Default down.",
        },
        amount: {
          type: "integer",
          minimum: 1,
          maximum: 20000,
          description: "Pixels for up/down. Default 600.",
        },
        selector: {
          type: "string",
          description: "Bring this element into view instead.",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "browser_wait_for",
    description:
      "Wait until a selector reaches a state or until the approved tab contains text.",
    inputSchema: {
      type: "object",
      properties: {
        tabId: TAB_ARG,
        selector: { type: "string", description: "CSS selector to wait for." },
        text: {
          type: "string",
          description: "Case-insensitive text to wait for.",
        },
        state: {
          type: "string",
          enum: ["attached", "visible", "hidden"],
          description: "Selector state. Default visible.",
        },
        timeoutMs: {
          type: "integer",
          minimum: 1000,
          maximum: 120000,
          description: "Timeout. Default 30000.",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "browser_evaluate",
    description:
      "Evaluate a JavaScript expression in the approved tab's page and return its JSON value. Page CSP may block eval on some sites.",
    inputSchema: {
      type: "object",
      properties: {
        tabId: TAB_ARG,
        expression: {
          type: "string",
          description:
            'Expression such as document.title or (async () => (await fetch("/api")).status)().',
        },
      },
      required: ["expression"],
      additionalProperties: false,
    },
  },
  {
    name: "browser_screenshot",
    description:
      "Capture the visible part of an approved tab as PNG or JPEG. The tab is activated first.",
    inputSchema: {
      type: "object",
      properties: {
        tabId: TAB_ARG,
        format: {
          type: "string",
          enum: ["png", "jpeg"],
          description: "Image format. Default png.",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "browser_activate_tab",
    description: "Switch to a tab after user approval.",
    inputSchema: {
      type: "object",
      properties: { tabId: TAB_ARG },
      additionalProperties: false,
    },
  },
  {
    name: "browser_close_tab",
    description: "Close a tab after user approval.",
    inputSchema: {
      type: "object",
      properties: { tabId: TAB_ARG },
      additionalProperties: false,
    },
  },
  {
    name: "browser_history",
    description: "Go back, go forward, or reload an approved tab.",
    inputSchema: {
      type: "object",
      properties: {
        tabId: TAB_ARG,
        action: {
          type: "string",
          enum: ["back", "forward", "reload"],
          description: "History action. Default back.",
        },
      },
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

function clampInteger(value, fallback, min, max) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(parsed, min), max);
}

function hashValue(value) {
  return createHash("sha256").update(String(value)).digest();
}

function tokenMatches(provided, expected) {
  return timingSafeEqual(hashValue(provided), hashValue(expected));
}

export function createRelay({
  extensionToken = "",
  commandTimeoutMs = DEFAULT_COMMAND_TIMEOUT_MS,
  logger = () => {},
} = {}) {
  const wsServer = new WebSocketServer({ noServer: true });
  const pending = new Map();
  let active = null;
  let closed = false;

  function rejectPending(message) {
    for (const entry of pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(new Error(message));
    }
    pending.clear();
  }

  function rejectSocket(socket, status, message) {
    try {
      socket.write(
        `HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: ${Buffer.byteLength(
          message,
        )}\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${message}`,
      );
    } catch {
      // Ignore write errors.
    }
    socket.destroy();
  }

  function handleUpgrade(request, socket, head) {
    let pathname;
    try {
      pathname = new URL(request.url || "/", "http://localhost").pathname;
    } catch {
      rejectSocket(socket, "400 Bad Request", "Bad request");
      return;
    }
    if (pathname !== "/extension") {
      rejectSocket(socket, "404 Not Found", "Not found");
      return;
    }

    const origin = request.headers.origin || "";
    const extensionOrigin = origin.startsWith("chrome-extension://");
    if (!extensionOrigin && !(extensionToken && !origin)) {
      rejectSocket(
        socket,
        "403 Forbidden",
        "WebSocket connections must come from the Chromium extension.",
      );
      return;
    }

    wsServer.handleUpgrade(request, socket, head, (ws) => {
      accept(ws, origin);
    });
  }

  function accept(ws, origin) {
    let ready = false;
    let identity = null;
    let heartbeatTimer = null;
    let lastPong = Date.now();

    const handshakeTimer = setTimeout(() => {
      if (!ready) ws.close(4408, "hello timeout");
    }, 10_000);
    handshakeTimer.unref?.();

    ws.on("message", (raw) => {
      let message;
      try {
        message = JSON.parse(raw.toString());
      } catch {
        return;
      }

      if (!ready) {
        if (message.type !== "hello") {
          ws.close(4400, "hello required");
          return;
        }
        if (extensionToken && !tokenMatches(message.token || "", extensionToken)) {
          try {
            ws.send(
              JSON.stringify({
                type: "hello-error",
                message: "Extension token rejected.",
              }),
            );
          } catch {
            // Closing below is enough.
          }
          ws.close(4401, "extension token rejected");
          return;
        }

        clearTimeout(handshakeTimer);
        ready = true;
        identity = {
          version:
            typeof message.version === "string" ? message.version : "unknown",
          origin,
          connectedAt: Date.now(),
          ws,
        };

        if (active && active.ws !== ws) {
          rejectPending("The browser extension connection was replaced.");
          try {
            active.ws.close(4409, "replaced by a newer browser connection");
          } catch {
            // Ignore.
          }
        }
        active = identity;
        ws.send(
          JSON.stringify({ type: "hello-ok", version: SERVER_INFO.version }),
        );
        logger(
          `extension connected (version ${identity.version}, origin ${origin || "unknown"})`,
        );

        lastPong = Date.now();
        heartbeatTimer = setInterval(() => {
          if (Date.now() - lastPong > 90_000) {
            logger("extension heartbeat timeout");
            try {
              ws.terminate();
            } catch {
              // The close handler cleans up.
            }
            return;
          }
          try {
            ws.send(JSON.stringify({ type: "ping", time: Date.now() }));
          } catch {
            // The close handler cleans up.
          }
        }, 20_000);
        heartbeatTimer.unref?.();
        return;
      }

      if (message.type === "pong") {
        lastPong = Date.now();
        return;
      }

      if (message.type === "ping") {
        try {
          ws.send(
            JSON.stringify({
              type: "pong",
              time: typeof message.time === "number" ? message.time : Date.now(),
            }),
          );
        } catch {
          // The close handler cleans up.
        }
        return;
      }

      if (message.type === "result" || message.type === "error") {
        const entry = pending.get(message.id);
        if (!entry) return;
        pending.delete(message.id);
        clearTimeout(entry.timer);
        if (message.ok) entry.resolve(message.result);
        else {
          entry.reject(
            new Error(message.message || "The browser command failed."),
          );
        }
      }
    });

    const cleanup = (code, reason) => {
      clearTimeout(handshakeTimer);
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      heartbeatTimer = null;
      if (active && active.ws === ws) {
        active = null;
        rejectPending("The browser extension disconnected.");
        const detail = reason ? reason.toString() : "";
        logger(
          `extension disconnected (code ${code ?? "unknown"}${
            detail ? `, ${detail}` : ""
          })`,
        );
      }
    };

    ws.on("close", (code, reason) => cleanup(code, reason));
    ws.on("error", () => {
      try {
        ws.terminate();
      } catch {
        // Ignore.
      }
    });
  }

  async function call(method, params = {}) {
    if (closed) throw new Error("The relay is closed.");
    if (!active) {
      throw new Error(
        "The Chromium extension is not connected. Load the extension and open its options to connect to this relay.",
      );
    }

    const id = randomUUID();
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(
          new Error(
            `The browser did not answer within ${Math.round(
              commandTimeoutMs / 1000,
            )} seconds.`,
          ),
        );
      }, commandTimeoutMs);
      timer.unref?.();
      pending.set(id, { resolve, reject, timer });

      try {
        active.ws.send(JSON.stringify({ type: "command", id, method, params }));
      } catch (error) {
        pending.delete(id);
        clearTimeout(timer);
        reject(error);
      }
    });
  }

  function status() {
    return {
      connected: Boolean(active),
      version: active?.version ?? null,
      connectedAt: active?.connectedAt ?? null,
      origin: active?.origin ?? null,
    };
  }

  async function close() {
    closed = true;
    rejectPending("The relay is shutting down.");
    const current = active;
    active = null;
    if (current) {
      try {
        current.ws.close(1001, "relay shutting down");
      } catch {
        // Ignore.
      }
    }
    wsServer.close();
  }

  return {
    handleUpgrade,
    call,
    status,
    close,
  };
}

async function callTool(relay, name, args) {
  if (!TOOL_NAMES.has(name)) return errorResult(`Unknown tool: ${name}`);

  try {
    if (name === "browser_status") {
      const status = relay.status();
      return textResult(
        status.connected
          ? `Extension connected (version ${status.version}).`
          : "Extension not connected. Open the Chromium extension options and connect it to the relay.",
      );
    }

    if (name === "browser_tabs") {
      const tabs = await relay.call("tabs.list");
      const lines = tabs.map(
        (tab) =>
          `${tab.active ? "*" : " "} ${tab.id}: ${
            tab.granted
              ? `${tab.title || "(untitled)"} - ${tab.url || ""}`
              : tab.restricted
                ? "(restricted tab; cannot be controlled)"
                : "(not approved; ask to access this tab to see its details)"
          }`,
      );
      return textResult(lines.length ? lines.join("\n") : "No tabs open.");
    }

    if (name === "browser_open") {
      const url = normalizeNavigationUrl(args.url);
      const result = await relay.call("page.open", {
        url,
        tabId: args.tabId,
        newTab: args.newTab,
        timeoutMs: args.timeoutMs,
        maxChars: clampInteger(args.maxChars, 20_000, 1, 200_000),
      });
      return textResult(
        `Opened ${result.url}\nTitle: ${result.title}\nTab: ${result.tabId}\n\n${result.text}${result.truncated ? "\n\n[content truncated]" : ""}`,
      );
    }

    if (name === "browser_read") {
      const result = await relay.call("page.read", {
        tabId: args.tabId,
        selector: args.selector,
        format: args.format,
        includeLinks: args.includeLinks,
        maxChars: clampInteger(args.maxChars, 20_000, 1, 200_000),
      });
      const links = result.links?.length
        ? `\n\nLinks:\n${result.links
            .map((link) => `- ${link.text || "(no text)"} -> ${link.href}`)
            .join("\n")}`
        : "";
      return textResult(
        `URL: ${result.url}\nTitle: ${result.title}\n\n${result.text}${result.truncated ? "\n\n[content truncated]" : ""}${links}`,
      );
    }

    if (name === "browser_snapshot") {
      const result = await relay.call("page.snapshot", {
        tabId: args.tabId,
        maxElements: clampInteger(args.maxElements, 200, 1, 1000),
      });
      return textResult(
        `URL: ${result.url}\nTitle: ${result.title}\nPreview: ${result.textPreview}\n\n${JSON.stringify(result.elements, null, 2)}`,
      );
    }

    if (name === "browser_click") {
      const result = await relay.call("page.click", {
        tabId: args.tabId,
        id: args.id,
        selector: args.selector,
        text: args.text,
      });
      return textResult(
        `Clicked ${result.label || "element"}.\nURL: ${result.url}\nTitle: ${result.title}\nTab: ${result.tabId}`,
      );
    }

    if (name === "browser_type") {
      const result = await relay.call("page.type", {
        tabId: args.tabId,
        id: args.id,
        selector: args.selector,
        text: args.text,
        value: args.value,
        clear: args.clear,
        submit: args.submit,
      });
      return textResult(
        `Typed into the tab.${args.submit ? " Submitted with Enter." : ""}\nURL: ${result.url}\nTitle: ${result.title}\nTab: ${result.tabId}`,
      );
    }

    if (name === "browser_press") {
      const result = await relay.call("page.press", {
        tabId: args.tabId,
        key: args.key,
        times: clampInteger(args.times, 1, 1, 20),
      });
      return textResult(
        `Pressed ${args.key}.\nURL: ${result.url}\nTitle: ${result.title}`,
      );
    }

    if (name === "browser_scroll") {
      const result = await relay.call("page.scroll", {
        tabId: args.tabId,
        direction: args.direction,
        amount: args.amount,
        selector: args.selector,
      });
      return textResult(
        `scrollY: ${result.scrollY} / ${Math.max(0, result.scrollHeight - result.viewportHeight)}`,
      );
    }

    if (name === "browser_wait_for") {
      const result = await relay.call("page.waitFor", {
        tabId: args.tabId,
        selector: args.selector,
        text: args.text,
        state: args.state,
        timeoutMs: args.timeoutMs,
      });
      return textResult(
        `Wait condition met.\nURL: ${result.url}\nTitle: ${result.title}`,
      );
    }

    if (name === "browser_evaluate") {
      const result = await relay.call("page.evaluate", {
        tabId: args.tabId,
        expression: args.expression,
      });
      return textResult(
        `Result:\n${JSON.stringify(
          result.value,
          (key, value) =>
            typeof value === "bigint" ? value.toString() : value,
          2,
        )}`,
      );
    }

    if (name === "browser_screenshot") {
      const result = await relay.call("page.screenshot", {
        tabId: args.tabId,
        format: args.format,
      });
      return {
        content: [
          {
            type: "text",
            text: `Screenshot of ${result.url} (${result.title || "untitled"}, tab ${result.tabId})`,
          },
          {
            type: "image",
            data: result.data,
            mimeType: result.mimeType,
          },
        ],
      };
    }

    if (name === "browser_activate_tab") {
      const result = await relay.call("tabs.activate", { tabId: args.tabId });
      return textResult(
        `Active tab: ${result.tabId}\nURL: ${result.url}\nTitle: ${result.title}`,
      );
    }

    if (name === "browser_close_tab") {
      const result = await relay.call("tab.close", { tabId: args.tabId });
      return textResult(`Closed tab ${result.closed}.`);
    }

    if (name === "browser_history") {
      const result = await relay.call("page.history", {
        tabId: args.tabId,
        action: args.action,
      });
      return textResult(
        `${args.action || "back"} complete.\nURL: ${result.url}\nTitle: ${result.title}\nTab: ${result.tabId}`,
      );
    }

    return errorResult(`Unknown tool: ${name}`);
  } catch (error) {
    return errorResult(error?.message || String(error));
  }
}

export function createMcpHandler(relay) {
  if (!relay || typeof relay.call !== "function") {
    throw new Error("createMcpHandler needs a relay");
  }

  return {
    async handle(method, params = {}) {
      switch (method) {
        case "initialize":
          return {
            protocolVersion: params.protocolVersion || PROTOCOL_VERSION,
            capabilities: { tools: {} },
            serverInfo: SERVER_INFO,
            instructions:
              "Controls the user's Chromium browser through the companion extension. The extension must be loaded and connected. Every tab access opens a confirmation window where the user chooses Allow once, Allow for session, or Deny. Use browser_tabs to discover tab ids; unapproved tabs hide their title and URL.",
          };
        case "ping":
          return {};
        case "tools/list":
          return { tools: TOOLS };
        case "tools/call":
          return await callTool(
            relay,
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

function setHttpCors(request, response, corsOrigins) {
  const origin = request.headers.origin;
  if (isOriginAllowed(origin, corsOrigins)) {
    response.setHeader(
      "Access-Control-Allow-Origin",
      corsOrigins.includes("*") ? "*" : origin,
    );
    response.setHeader("Vary", "Origin");
  }
  response.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  response.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Accept, Authorization, Mcp-Session-Id, Mcp-Protocol-Version, Last-Event-ID",
  );
  response.setHeader("Access-Control-Expose-Headers", "Mcp-Session-Id");
  response.setHeader("Access-Control-Max-Age", "600");
  if (request.headers["access-control-request-private-network"] === "true") {
    response.setHeader("Access-Control-Allow-Private-Network", "true");
  }
}

function sendJson(response, status, value) {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
  });
  response.end(body);
}

function readRequestBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_HTTP_BODY_BYTES) {
        reject(new Error("Request body is too large"));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => resolve(Buffer.concat(chunks)));
    request.on("error", reject);
  });
}

function requireBearer(request, token) {
  if (!token) return true;
  const header = request.headers.authorization;
  if (typeof header !== "string") return false;
  const match = header.match(/^Bearer\s+(.+)$/i);
  if (!match) return false;
  return tokenMatches(match[1].trim(), token);
}

export function createHttpServer({ relay, mcp, token = "", corsOrigins } = {}) {
  if (!relay || typeof relay.handleUpgrade !== "function") {
    throw new Error("createHttpServer needs a relay");
  }
  if (!mcp || typeof mcp.handle !== "function") {
    throw new Error("createHttpServer needs an MCP handler");
  }

  const bearerToken = typeof token === "string" ? token.trim() : "";
  const origins =
    corsOrigins ??
    resolveCorsOrigins(process.env.MCP_CHROMIUM_CORS_ORIGIN || "");

  const server = http.createServer(async (request, response) => {
    const url = new URL(
      request.url || "/",
      `http://${request.headers.host || "127.0.0.1"}`,
    );
    setHttpCors(request, response, origins);

    if (request.method === "OPTIONS") {
      response.writeHead(204);
      response.end();
      return;
    }

    if (request.method === "GET" && url.pathname === "/health") {
      sendJson(response, 200, {
        ok: true,
        extension: relay.status().connected,
      });
      return;
    }

    if (url.pathname !== "/mcp") {
      sendJson(response, 404, { error: "Not found" });
      return;
    }

    if (!requireBearer(request, bearerToken)) {
      response.setHeader("WWW-Authenticate", 'Bearer realm="chromium-mcp"');
      response.setHeader("Cache-Control", "no-store");
      sendJson(response, 401, { error: "Unauthorized" });
      return;
    }

    if (request.method === "GET") {
      response.writeHead(405, { Allow: "POST, DELETE, OPTIONS" });
      response.end();
      return;
    }

    if (request.method === "DELETE") {
      response.writeHead(204);
      response.end();
      return;
    }

    if (request.method !== "POST") {
      response.writeHead(405, { Allow: "POST, DELETE, OPTIONS" });
      response.end();
      return;
    }

    let rawBody;
    try {
      rawBody = await readRequestBody(request);
    } catch (error) {
      sendJson(response, 413, { error: error.message });
      return;
    }

    let message;
    try {
      message = JSON.parse(rawBody.toString("utf8"));
    } catch {
      sendJson(response, 400, {
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
      sendJson(response, 400, {
        jsonrpc: "2.0",
        id: message?.id ?? null,
        error: { code: -32600, message: "Invalid Request" },
      });
      return;
    }

    if (message.id === undefined) {
      response.writeHead(202);
      response.end();
      return;
    }

    try {
      const result = await mcp.handle(message.method, message.params || {});
      sendJson(response, 200, {
        jsonrpc: "2.0",
        id: message.id,
        result,
      });
    } catch (error) {
      sendJson(response, 200, {
        jsonrpc: "2.0",
        id: message.id,
        error: {
          code: Number.isFinite(error?.code) ? error.code : -32603,
          message: error?.message || String(error),
        },
      });
    }
  });

  server.on("upgrade", (request, socket, head) => {
    relay.handleUpgrade(request, socket, head);
  });

  return server;
}

export function createExtensionServer({ relay } = {}) {
  if (!relay || typeof relay.handleUpgrade !== "function") {
    throw new Error("createExtensionServer needs a relay");
  }
  const server = http.createServer((request, response) => {
    response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("This endpoint only accepts the extension WebSocket.\n");
  });
  server.on("upgrade", (request, socket, head) => {
    relay.handleUpgrade(request, socket, head);
  });
  return server;
}

function parsePort(value, fallback) {
  const parsed = Number(value || fallback);
  return Number.isInteger(parsed) && parsed >= 0 && parsed <= 65535
    ? parsed
    : fallback;
}

function mainHttp() {
  const requestedHost = process.env.HOST || "127.0.0.1";
  if (!LOOPBACK_HOSTS.includes(requestedHost)) {
    console.error(
      `Refusing to listen on ${requestedHost}: chromium-mcp only binds to loopback (${LOOPBACK_HOSTS.join(", ")}).`,
    );
    process.exit(1);
  }
  const host = requestedHost === "[::1]" ? "::1" : requestedHost;
  const port = parsePort(process.env.MCP_CHROMIUM_HTTP_PORT, DEFAULT_HTTP_PORT);
  const corsOrigins = resolveCorsOrigins(
    process.env.MCP_CHROMIUM_CORS_ORIGIN || "",
  );
  const token = (process.env.MCP_CHROMIUM_TOKEN || "").trim();
  const extensionToken = (process.env.MCP_CHROMIUM_EXTENSION_TOKEN || "").trim();
  const commandTimeoutMs =
    Number(process.env.MCP_CHROMIUM_COMMAND_TIMEOUT_MS) ||
    DEFAULT_COMMAND_TIMEOUT_MS;

  const relay = createRelay({ extensionToken, commandTimeoutMs, logger: console.error });
  const mcp = createMcpHandler(relay);
  const server = createHttpServer({ relay, mcp, token, corsOrigins });

  server.on("error", (error) => {
    console.error(`chromium-mcp HTTP server error: ${error.message}`);
    process.exit(1);
  });

  server.listen(port, host, () => {
    const address = server.address();
    const actualPort =
      typeof address === "object" && address ? address.port : port;
    const displayHost = host === "::1" ? "[::1]" : host;

    console.log(
      `chromium-mcp HTTP server listening on ${displayHost}:${actualPort}`,
    );
    console.log("Use the following MCP endpoint in Chat AI:");
    console.log(`http://${displayHost}:${actualPort}/mcp`);
    console.log("Extension WebSocket:");
    console.log(`ws://${displayHost}:${actualPort}/extension`);
    console.log(
      corsOrigins.length
        ? `CORS origins: ${corsOrigins.join(", ")}`
        : "CORS origins: localhost/127.0.0.1 only",
    );
    console.log(
      token
        ? "Authentication: Bearer token required"
        : "Authentication: disabled (set MCP_CHROMIUM_TOKEN to require a Bearer token)",
    );
    console.log(
      extensionToken
        ? "Extension authentication: token required"
        : "Extension authentication: chrome-extension origin only",
    );
  });

  let shuttingDown = false;
  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    server.close(() => {
      relay.close().finally(() => process.exit(0));
    });
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

function mainStdio() {
  const port = parsePort(
    process.env.MCP_CHROMIUM_EXTENSION_PORT,
    DEFAULT_HTTP_PORT,
  );
  const extensionToken = (process.env.MCP_CHROMIUM_EXTENSION_TOKEN || "").trim();
  const commandTimeoutMs =
    Number(process.env.MCP_CHROMIUM_COMMAND_TIMEOUT_MS) ||
    DEFAULT_COMMAND_TIMEOUT_MS;

  const relay = createRelay({ extensionToken, commandTimeoutMs, logger: console.error });
  const mcp = createMcpHandler(relay);
  const server = createExtensionServer({ relay });

  server.on("error", (error) => {
    console.error(`chromium-mcp extension server error: ${error.message}`);
    process.exit(1);
  });

  server.listen(port, "127.0.0.1", () => {
    const address = server.address();
    const actualPort =
      typeof address === "object" && address ? address.port : port;
    console.error(
      `Extension WebSocket: ws://127.0.0.1:${actualPort}/extension`,
    );
    console.error("chromium-mcp ready (stdio). Extension must be connected.");
  });

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
      const result = await mcp.handle(message.method, message.params || {});
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
        console.error(`chromium-mcp: ${error?.message || error}`);
      });
    }
  });

  process.stdin.on("end", () => {
    queue.finally(() => {
      server.close(() => {
        relay.close().finally(() => process.exit(0));
      });
    });
  });

  process.stdout.on("error", () => process.exit(0));
  process.stdin.on("error", () => process.exit(0));

  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, () => {
      server.close(() => {
        relay.close().finally(() => process.exit(0));
      });
    });
  }
}

function main() {
  const useHttp =
    process.argv.includes("--http") ||
    process.env.MCP_CHROMIUM_TRANSPORT === "http";
  if (useHttp) mainHttp();
  else mainStdio();
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
