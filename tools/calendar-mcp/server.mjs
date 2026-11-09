#!/usr/bin/env node
// Local MCP server for CalDAV calendars. Read tools are free; changes use a
// native confirmation dialog with Allow once / Allow for session / Deny.

import { createHash, timingSafeEqual } from "node:crypto";
import { realpathSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { ActionApprovals } from "./approvals.mjs";
import { createCalDavClient } from "./caldav.mjs";
import { loadConfig } from "./config.mjs";

export const SERVER_INFO = { name: "calendar-mcp", version: "0.1.0" };
export const PROTOCOL_VERSION = "2025-06-18";

const MAX_HTTP_BODY_BYTES = 1024 * 1024;
const LOOPBACK_HOSTS = ["127.0.0.1", "localhost", "::1", "[::1]"];
const DEFAULT_HTTP_PORT = 8767;

const TOOLS = [
  {
    name: "list_calendars",
    description:
      "List the CalDAV calendars available to the configured account.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "list_events",
    description:
      "List calendar events in a time range, optionally filtered by calendar or text. Read-only.",
    inputSchema: {
      type: "object",
      properties: {
        calendar_id: {
          type: "string",
          description: "Calendar id, URL, or display name. Defaults to all calendars.",
        },
        from: {
          type: "string",
          description: "Start of the range as ISO-8601. Default now.",
        },
        to: {
          type: "string",
          description: "End of the range as ISO-8601. Default 30 days after from.",
        },
        query: {
          type: "string",
          description: "Case-insensitive text filter over summary, description, location, and attendees.",
        },
        limit: {
          type: "integer",
          minimum: 1,
          maximum: 500,
          description: "Maximum events. Default 100.",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "get_event",
    description:
      "Get one event by event_id, including attendees, organizer, and your participation status. Read-only.",
    inputSchema: {
      type: "object",
      properties: {
        event_id: { type: "string", description: "event_id from list_events." },
      },
      required: ["event_id"],
      additionalProperties: false,
    },
  },
  {
    name: "create_event",
    description:
      "Create a meeting with attendees. Requires native confirmation. Date-times are stored in UTC; date-only values create all-day events and the end date is exclusive.",
    inputSchema: {
      type: "object",
      properties: {
        calendar_id: {
          type: "string",
          description: "Target calendar id, URL, or name. Defaults to the first writable calendar or configured default.",
        },
        summary: { type: "string", description: "Meeting title." },
        start: {
          type: "string",
          description: "ISO-8601 date-time or YYYY-MM-DD for an all-day event.",
        },
        end: {
          type: "string",
          description: "ISO-8601 date-time or YYYY-MM-DD (exclusive for all-day).",
        },
        description: { type: "string", description: "Optional description or agenda." },
        location: { type: "string", description: "Optional location." },
        attendees: {
          type: "array",
          description: "People to invite.",
          items: {
            oneOf: [
              { type: "string", description: "Email address" },
              {
                type: "object",
                properties: {
                  email: { type: "string" },
                  name: { type: "string" },
                },
                required: ["email"],
                additionalProperties: false,
              },
            ],
          },
        },
      },
      required: ["summary", "start", "end"],
      additionalProperties: false,
    },
  },
  {
    name: "respond_to_event",
    description:
      "Accept, tentatively accept, or decline a meeting invitation. Requires native confirmation. As organizer, accepted/tentative marks the event confirmed; declining is not allowed here.",
    inputSchema: {
      type: "object",
      properties: {
        event_id: { type: "string", description: "event_id from list_events." },
        response: {
          type: "string",
          enum: ["accepted", "declined", "tentative"],
          description: "Your response.",
        },
      },
      required: ["event_id", "response"],
      additionalProperties: false,
    },
  },
];

const TOOL_NAMES = new Set(TOOLS.map((tool) => tool.name));

function textResult(value) {
  const payload =
    typeof value === "string" ? value : JSON.stringify(value, null, 2);
  return { content: [{ type: "text", text: payload }] };
}

function errorResult(message) {
  return { content: [{ type: "text", text: message }], isError: true };
}

function fieldLines(values) {
  return Object.entries(values)
    .filter(([, value]) => value !== undefined && value !== null && value !== "")
    .map(([key, value]) => {
      if (Array.isArray(value)) return `${key}: ${value.join(", ")}`;
      return `${key}: ${String(value)}`;
    })
    .join("\n");
}

function addDays(date, days) {
  return new Date(date.getTime() + days * 24 * 60 * 60 * 1000);
}

function requireString(value, name) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${name} is required.`);
  }
  return value.trim();
}

function attendeeSummary(attendees) {
  if (!Array.isArray(attendees) || !attendees.length) return "(none)";
  return attendees
    .map((entry) =>
      typeof entry === "string" ? entry : entry?.email || "(invalid)",
    )
    .join(", ");
}

export function createCalendarServer({
  client,
  approvals = new ActionApprovals(),
  config,
} = {}) {
  if (!client || typeof client.listCalendars !== "function") {
    throw new Error("createCalendarServer needs a calendar client");
  }

  async function callTool(name, args) {
    if (!TOOL_NAMES.has(name)) return errorResult(`Unknown tool: ${name}`);
    try {
      if (name === "list_calendars") {
        return textResult({ calendars: await client.listCalendars() });
      }
      if (name === "list_events") {
        const from = args.from ? new Date(args.from) : new Date();
        const to = args.to ? new Date(args.to) : addDays(from, 30);
        if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
          throw new Error("from and to must be valid ISO-8601 dates.");
        }
        return textResult(
          await client.listEvents({
            calendarId: args.calendar_id,
            from: from.toISOString(),
            to: to.toISOString(),
            query: args.query,
            limit: args.limit,
          }),
        );
      }
      if (name === "get_event") {
        return textResult(
          await client.getEvent(requireString(args.event_id, "event_id")),
        );
      }
      if (name === "create_event") {
        if (config?.readOnly) {
          throw new Error("The calendar configuration is read-only.");
        }
        const summary = requireString(args.summary, "summary");
        const start = requireString(args.start, "start");
        const end = requireString(args.end, "end");
        await approvals.require(
          "create_event",
          "create a calendar meeting",
          fieldLines({
            title: summary,
            start,
            end,
            calendar: args.calendar_id || "(default)",
            location: args.location,
            attendees: attendeeSummary(args.attendees),
          }),
        );
        return textResult(
          await client.createEvent({
            calendar_id: args.calendar_id,
            summary,
            start,
            end,
            description: args.description,
            location: args.location,
            attendees: args.attendees,
          }),
        );
      }
      if (name === "respond_to_event") {
        if (config?.readOnly) {
          throw new Error("The calendar configuration is read-only.");
        }
        const eventId = requireString(args.event_id, "event_id");
        const response = requireString(args.response, "response");
        if (!["accepted", "declined", "tentative"].includes(response)) {
          throw new Error("response must be accepted, declined, or tentative.");
        }
        const event = await client.getEvent(eventId);
        await approvals.require(
          "respond_to_event",
          "respond to a calendar invitation",
          fieldLines({
            event: event.summary,
            start: event.start,
            end: event.end,
            response,
          }),
        );
        return textResult(
          await client.respondToEvent({
            event_id: eventId,
            response,
          }),
        );
      }
      return errorResult(`Unknown tool: ${name}`);
    } catch (error) {
      return errorResult(error instanceof Error ? error.message : String(error));
    }
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
              "CalDAV calendar access. Reading calendars and events is free. Creating meetings and responding to invitations requires native confirmation: Allow once, Allow for session, or Deny. Times are stored in UTC; date-only events are all-day and their end date is exclusive. The CalDAV server sends invitations through its scheduling support.",
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

function resolveCorsOrigins(value) {
  return String(value || "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
}

const DEFAULT_CORS_ORIGINS = ["*.chat-ai.academiccloud.de"];

function originMatchesPattern(origin, pattern) {
  if (pattern === "*" || pattern === origin) return true;
  if (!pattern.startsWith("*.")) return false;
  try {
    const { protocol, hostname } = new URL(origin);
    if (protocol !== "https:") return false;
    const suffix = pattern.slice(2).toLowerCase();
    const host = hostname.toLowerCase();
    return host === suffix || host.endsWith(`.${suffix}`);
  } catch {
    return false;
  }
}

function isOriginAllowed(origin, corsOrigins) {
  if (!origin) return false;
  const patterns = corsOrigins.length ? corsOrigins : DEFAULT_CORS_ORIGINS;
  if (patterns.some((pattern) => originMatchesPattern(origin, pattern))) {
    return true;
  }
  if (corsOrigins.length) return false;
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

function hashValue(value) {
  return createHash("sha256").update(String(value)).digest();
}

function bearerMatches(request, expected) {
  const header = request.headers.authorization;
  if (typeof header !== "string") return false;
  const match = header.match(/^Bearer\s+(.+)$/i);
  if (!match) return false;
  return timingSafeEqual(hashValue(match[1].trim()), hashValue(expected));
}

export function createHttpServer({ mcp, token = "", corsOrigins } = {}) {
  if (!mcp || typeof mcp.handle !== "function") {
    throw new Error("createHttpServer needs an MCP handler");
  }
  const bearer = typeof token === "string" ? token.trim() : "";
  const origins =
    corsOrigins ??
    resolveCorsOrigins(process.env.CALENDAR_MCP_CORS_ORIGIN || "");

  return http.createServer(async (request, response) => {
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
      sendJson(response, 200, { ok: true });
      return;
    }
    if (url.pathname !== "/mcp") {
      sendJson(response, 404, { error: "Not found" });
      return;
    }
    if (bearer && !bearerMatches(request, bearer)) {
      response.setHeader("WWW-Authenticate", 'Bearer realm="calendar-mcp"');
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

    let raw;
    try {
      raw = await readRequestBody(request);
    } catch (error) {
      sendJson(response, 413, { error: error.message });
      return;
    }
    let message;
    try {
      message = JSON.parse(raw.toString("utf8"));
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
      sendJson(response, 200, { jsonrpc: "2.0", id: message.id, result });
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
}

function parseCliConfig(argv) {
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--config" && argv[index + 1]) return argv[index + 1];
    if (argv[index].startsWith("--config=")) return argv[index].slice(9);
  }
  return "";
}

function mainHttp(configLocation) {
  const requestedHost = process.env.HOST || "127.0.0.1";
  if (!LOOPBACK_HOSTS.includes(requestedHost)) {
    console.error(
      `Refusing to listen on ${requestedHost}: calendar-mcp only binds to loopback.`,
    );
    process.exit(1);
  }
  const host = requestedHost === "[::1]" ? "::1" : requestedHost;
  const requestedPort = Number(
    process.env.CALENDAR_MCP_HTTP_PORT || DEFAULT_HTTP_PORT,
  );
  const port =
    Number.isInteger(requestedPort) && requestedPort >= 0 && requestedPort <= 65535
      ? requestedPort
      : DEFAULT_HTTP_PORT;
  const corsOrigins = resolveCorsOrigins(
    process.env.CALENDAR_MCP_CORS_ORIGIN || "",
  );
  const token = (process.env.CALENDAR_MCP_TOKEN || "").trim();

  let config;
  try {
    config = loadConfig(configLocation);
  } catch (error) {
    console.error(`calendar-mcp: ${error instanceof Error ? error.message : error}`);
    process.exit(1);
  }
  const client = createCalDavClient(config);
  const mcp = createCalendarServer({ client, config });
  const server = createHttpServer({ mcp, token, corsOrigins });

  server.on("error", (error) => {
    console.error(`calendar-mcp HTTP server error: ${error.message}`);
    process.exit(1);
  });
  server.listen(port, host, () => {
    const address = server.address();
    const actualPort =
      typeof address === "object" && address ? address.port : port;
    const displayHost = host === "::1" ? "[::1]" : host;
    console.log(
      `calendar-mcp HTTP server listening on ${displayHost}:${actualPort}`,
    );
    console.log("Use the following MCP endpoint in Chat AI:");
    console.log(`http://${displayHost}:${actualPort}/mcp`);
    console.log(`Calendar config: ${config.configPath}`);
    console.log(
      corsOrigins.length
        ? `CORS origins: ${corsOrigins.join(", ")}`
        : "CORS origins: localhost/127.0.0.1 and *.chat-ai.academiccloud.de",
    );
    console.log(
      token
        ? "Authentication: Bearer token required"
        : "Authentication: disabled (set CALENDAR_MCP_TOKEN to require a Bearer token)",
    );
  });

  const shutdown = () => {
    server.close(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

function mainStdio(configLocation) {
  let config;
  try {
    config = loadConfig(configLocation);
  } catch (error) {
    console.error(`calendar-mcp: ${error instanceof Error ? error.message : error}`);
    process.exit(1);
  }
  const client = createCalDavClient(config);
  const mcp = createCalendarServer({ client, config });

  process.stdin.setEncoding("utf8");
  let buffer = "";
  let queue = Promise.resolve();
  const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);

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
        console.error(`calendar-mcp: ${error?.message || error}`);
      });
    }
  });
  process.stdin.on("end", () => queue.finally(() => process.exit(0)));
  process.stdout.on("error", () => process.exit(0));
  process.stdin.on("error", () => process.exit(0));
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, () => process.exit(0));
  }

  console.error(
    `calendar-mcp ready (stdio). Config: ${config.configPath}. Changes require native confirmation.`,
  );
}

function main() {
  const configLocation = parseCliConfig(process.argv.slice(2));
  const useHttp =
    process.argv.includes("--http") ||
    process.env.CALENDAR_MCP_TRANSPORT === "http";
  if (useHttp) mainHttp(configLocation);
  else mainStdio(configLocation);
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
