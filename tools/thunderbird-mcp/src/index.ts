#!/usr/bin/env node
import { randomUUID, timingSafeEqual } from "node:crypto";
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from "node:http";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";

import { DEFAULT_MCP_PASSWORD } from "./auth.js";
import { promptPassword } from "./passwordPrompt.js";
import { debugLog, setDebugEnabled } from "./logging.js";
import { createServer, type ServerOptions } from "./server.js";

type TransportMode = "stdio" | "http";

interface CliOptions extends ServerOptions {
  transport: TransportMode;
  host: string;
  port: number;
  token?: string;
  password: string;
  askPassword: boolean;
  corsOrigin?: string;
}

function envFlag(value: string | undefined): boolean {
  return value === "1" || value?.toLowerCase() === "true";
}

function usage(): string {
  return `thunderbird-mcp ${"1.0.0"}

Read Thunderbird mail through the extension and create drafts over MCP.

Usage:
  thunderbird-mcp [options]

Options:
  --profile <dir>       Thunderbird profile directory (default: auto-detect, or THUNDERBIRD_PROFILE)
  --read-only           Hide create_draft and flag-writing tools
  --debug               Log every tool call, arguments, and errors to stderr
  --transport <mode>    stdio (default) or http
  --http                Shorthand for --transport http
  --host <host>         HTTP bind address (default: 127.0.0.1)
  --port <port>         HTTP port (default: 8765)
  --password [password] HTTP bearer password (default: Zinnober, or THUNDERBIRD_MCP_PASSWORD).
                        Without a value, a native password prompt opens.
  --ask-password        Open a native password prompt at startup
  --token <token>       HTTP Bearer token (default: HTTP bearer password, or THUNDERBIRD_MCP_TOKEN)
  --cors-origin <list>  Comma-separated allowed browser origins; supports * and *.domain
                        wildcards (default: localhost/127.0.0.1 and *.chat-ai.academiccloud.de)
  -h, --help            Show this help
  -v, --version         Show the version

Environment:
  THUNDERBIRD_PROFILE, THUNDERBIRD_MCP_READ_ONLY, THUNDERBIRD_MCP_DEBUG,
  THUNDERBIRD_MCP_TRANSPORT, THUNDERBIRD_MCP_HOST, THUNDERBIRD_MCP_PORT,
  THUNDERBIRD_MCP_PASSWORD, THUNDERBIRD_MCP_TOKEN, THUNDERBIRD_MCP_CORS_ORIGIN

All mail access goes through the Thunderbird MCP extension. The server never
sends, deletes, or moves mail. It can create drafts and set read/answered flags.
`;
}

function readOption(args: string[], index: number, name: string): { value: string; next: number } {
  const value = args[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`Missing value for ${name}.`);
  }
  return { value, next: index + 2 };
}

function parseOptions(argv: string[]): CliOptions | null {
  const envTransport = process.env.THUNDERBIRD_MCP_TRANSPORT?.toLowerCase();
  const options: CliOptions = {
    transport: envTransport === "http" ? "http" : "stdio",
    host: process.env.THUNDERBIRD_MCP_HOST || "127.0.0.1",
    port: Number.parseInt(process.env.THUNDERBIRD_MCP_PORT || "8765", 10),
    profile: process.env.THUNDERBIRD_PROFILE,
    readOnly: envFlag(process.env.THUNDERBIRD_MCP_READ_ONLY),
    debug: envFlag(process.env.THUNDERBIRD_MCP_DEBUG),
    token: process.env.THUNDERBIRD_MCP_TOKEN,
    password: process.env.THUNDERBIRD_MCP_PASSWORD || DEFAULT_MCP_PASSWORD,
    askPassword: false,
    corsOrigin: process.env.THUNDERBIRD_MCP_CORS_ORIGIN,
  };

  let index = 0;
  while (index < argv.length) {
    const arg = argv[index];
    if (arg === "-h" || arg === "--help") {
      process.stdout.write(usage());
      return null;
    }
    if (arg === "-v" || arg === "--version") {
      process.stdout.write("1.0.0\n");
      return null;
    }
    if (arg === "--http") {
      options.transport = "http";
      index += 1;
      continue;
    }
    if (arg === "--read-only") {
      options.readOnly = true;
      index += 1;
      continue;
    }
    if (arg === "--debug") {
      options.debug = true;
      index += 1;
      continue;
    }
    if (arg === "--transport") {
      const parsed = readOption(argv, index, arg);
      if (parsed.value !== "stdio" && parsed.value !== "http") {
        throw new Error("--transport must be stdio or http.");
      }
      options.transport = parsed.value;
      index = parsed.next;
      continue;
    }
    if (arg === "--profile") {
      const parsed = readOption(argv, index, arg);
      options.profile = parsed.value;
      index = parsed.next;
      continue;
    }
    if (arg === "--host") {
      const parsed = readOption(argv, index, arg);
      options.host = parsed.value;
      index = parsed.next;
      continue;
    }
    if (arg === "--port") {
      const parsed = readOption(argv, index, arg);
      options.port = Number.parseInt(parsed.value, 10);
      if (!Number.isInteger(options.port) || options.port <= 0 || options.port > 65535) {
        throw new Error("--port must be an integer between 1 and 65535.");
      }
      index = parsed.next;
      continue;
    }
    if (arg === "--ask-password") {
      options.askPassword = true;
      index += 1;
      continue;
    }
    if (arg === "--password") {
      const next = argv[index + 1];
      if (!next || next.startsWith("--")) {
        options.askPassword = true;
        index += 1;
        continue;
      }
      options.password = next;
      index += 2;
      continue;
    }
    if (arg === "--token") {
      const parsed = readOption(argv, index, arg);
      options.token = parsed.value;
      index = parsed.next;
      continue;
    }
    if (arg === "--cors-origin") {
      const parsed = readOption(argv, index, arg);
      options.corsOrigin = parsed.value;
      index = parsed.next;
      continue;
    }
    throw new Error(`Unknown option: ${arg}`);
  }

  if (!Number.isInteger(options.port) || options.port <= 0 || options.port > 65535) {
    throw new Error("THUNDERBIRD_MCP_PORT must be an integer between 1 and 65535.");
  }
  return options;
}

function bearerToken(request: IncomingMessage): string | undefined {
  const header = request.headers.authorization;
  if (!header) return undefined;
  const match = /^Bearer\s+(.+)$/i.exec(header);
  return match?.[1]?.trim();
}

function tokenMatches(expected: string, actual: string | undefined): boolean {
  if (!actual) return false;
  const left = Buffer.from(expected);
  const right = Buffer.from(actual);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

async function readJsonBody(request: IncomingMessage, limit = 50 * 1024 * 1024): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > limit) throw new Error("Request body is too large.");
    chunks.push(buffer);
  }
  if (!size) return undefined;
  const text = Buffer.concat(chunks).toString("utf8");
  return JSON.parse(text) as unknown;
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload),
  });
  response.end(payload);
}

function isLoopback(host: string): boolean {
  return host === "127.0.0.1" || host === "::1" || host === "localhost";
}

function resolveCorsOrigins(value: string | undefined): string[] {
  return String(value || "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
}

const DEFAULT_CORS_ORIGINS = ["*.chat-ai.academiccloud.de"];

function originMatchesPattern(origin: string, pattern: string): boolean {
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

function isAllowedOrigin(origin: string | undefined, configured: string[]): boolean {
  if (!origin) return false;
  const patterns = configured.length ? configured : DEFAULT_CORS_ORIGINS;
  if (patterns.some((pattern) => originMatchesPattern(origin, pattern))) {
    return true;
  }
  if (configured.length) return false;

  try {
    const { hostname } = new URL(origin);
    return ["127.0.0.1", "localhost", "[::1]"].includes(hostname);
  } catch {
    return false;
  }
}

function applyCors(
  request: IncomingMessage,
  response: ServerResponse,
  configured: string[],
): void {
  const origin = request.headers.origin;
  if (isAllowedOrigin(origin, configured)) {
    response.setHeader(
      "Access-Control-Allow-Origin",
      configured.includes("*") ? "*" : origin!,
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

async function runStdio(options: CliOptions): Promise<void> {
  const server: McpServer = createServer({ ...options });
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`[thunderbird-mcp] stdio ready${options.readOnly ? " (read-only)" : ""}`);
  debugLog(
    `stdio startup debug=${Boolean(options.debug)} profile=${options.profile ?? "(auto)"} readOnly=${Boolean(options.readOnly)}`,
  );

  const shutdown = () => {
    void server.close().finally(() => process.exit(0));
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

async function runHttp(options: CliOptions): Promise<void> {
  setDebugEnabled(Boolean(options.debug));
  const httpToken = options.token || options.password;
  const corsOrigins = resolveCorsOrigins(options.corsOrigin);
  if (!isLoopback(options.host) && !options.token) {
    console.error(
      "[thunderbird-mcp] WARNING: binding to a non-loopback address without an explicit --token/THUNDERBIRD_MCP_TOKEN; using the HTTP bearer password as token.",
    );
  }

  const sessions = new Map<
    string,
    { transport: StreamableHTTPServerTransport; server: McpServer }
  >();

  const httpServer = createHttpServer(async (request, response) => {
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
    debugLog(`http ${request.method} ${url.pathname}`);
    applyCors(request, response, corsOrigins);

    if (request.method === "OPTIONS") {
      response.writeHead(204);
      response.end();
      return;
    }

    if (request.method === "GET" && url.pathname === "/health") {
      sendJson(response, 200, {
        status: "ok",
        name: "thunderbird-mcp",
        version: "1.0.0",
        readOnly: Boolean(options.readOnly),
      });
      return;
    }

    if (url.pathname !== "/mcp") {
      sendJson(response, 404, {
        error: "Not found",
        endpoints: ["POST /mcp", "GET /health"],
      });
      return;
    }

    if (!tokenMatches(httpToken, bearerToken(request))) {
      response.setHeader("WWW-Authenticate", 'Bearer realm="thunderbird-mcp"');
      sendJson(response, 401, { error: "Unauthorized" });
      return;
    }

    if (
      request.method !== "POST" &&
      request.method !== "GET" &&
      request.method !== "DELETE"
    ) {
      response.setHeader("Allow", "GET, POST, DELETE");
      sendJson(response, 405, { error: "Method not allowed." });
      return;
    }

    const rawSessionId = request.headers["mcp-session-id"];
    const sessionId = typeof rawSessionId === "string" ? rawSessionId : undefined;
    if (sessionId) {
      const session = sessions.get(sessionId);
      if (!session) {
        sendJson(response, 404, { error: "Session not found" });
        return;
      }
      let body: unknown;
      if (request.method === "POST") {
        try {
          body = await readJsonBody(request);
        } catch (error) {
          sendJson(response, 400, {
            error: "Invalid JSON body",
            detail: error instanceof Error ? error.message : String(error),
          });
          return;
        }
      }
      try {
        await session.transport.handleRequest(request, response, body);
      } catch (error) {
        if (!response.headersSent) {
          sendJson(response, 500, {
            error: "MCP request failed",
            detail: error instanceof Error ? error.message : String(error),
          });
        } else {
          response.end();
        }
      }
      return;
    }

    if (request.method !== "POST") {
      sendJson(response, 400, { error: "Missing MCP session id" });
      return;
    }

    let body: unknown;
    try {
      body = await readJsonBody(request);
    } catch (error) {
      sendJson(response, 400, {
        error: "Invalid JSON body",
        detail: error instanceof Error ? error.message : String(error),
      });
      return;
    }
    if (!isInitializeRequest(body)) {
      sendJson(response, 400, { error: "Bad Request: initialization required" });
      return;
    }

    const mcp = createServer({ ...options });
    let transport: StreamableHTTPServerTransport;
    transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      enableJsonResponse: true,
      onsessioninitialized: (id) => {
        sessions.set(id, { transport, server: mcp });
      },
    });
    transport.onclose = () => {
      const id = transport.sessionId;
      if (id) sessions.delete(id);
      void mcp.close().catch(() => undefined);
    };

    try {
      await mcp.connect(transport);
      await transport.handleRequest(request, response, body);
    } catch (error) {
      if (!response.headersSent) {
        sendJson(response, 500, {
          error: "MCP request failed",
          detail: error instanceof Error ? error.message : String(error),
        });
      } else {
        response.end();
      }
      await mcp.close().catch(() => undefined);
    }
  });

  await new Promise<void>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(options.port, options.host, () => resolve());
  });

  console.error(
    `[thunderbird-mcp] HTTP ready at http://${options.host}:${options.port}/mcp${
      options.readOnly ? " (read-only)" : ""
    }`,
  );
  console.error(
    `[thunderbird-mcp] CORS origins: ${
      corsOrigins.length
        ? corsOrigins.join(", ")
        : "localhost/127.0.0.1 and *.chat-ai.academiccloud.de"
    }`,
  );

  const shutdown = () => {
    for (const session of sessions.values()) {
      void session.server.close().catch(() => undefined);
    }
    httpServer.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  if (!options) return;

  if (options.askPassword) {
    const password = await promptPassword(
      "Set the HTTP bearer password. Leave empty to cancel.",
    );
    if (!password) {
      throw new Error("No password was provided. Set one with --password or THUNDERBIRD_MCP_PASSWORD.");
    }
    options.password = password;
  }

  if (options.transport === "http") await runHttp(options);
  else await runStdio(options);
}

main().catch((error: unknown) => {
  console.error(`[thunderbird-mcp] ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
