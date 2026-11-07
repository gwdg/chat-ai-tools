#!/usr/bin/env node
import { randomUUID, timingSafeEqual } from "node:crypto";
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";

import { DEFAULT_MCP_PASSWORD } from "./auth.js";
import { closeDatabase, openDatabase, resolveDatabasePath } from "./db.js";
import { promptPassword } from "./passwordPrompt.js";
import { debugLog, setDebugEnabled } from "./logging.js";
import { createServer } from "./server.js";
import { CrmStore } from "./store.js";

type TransportMode = "stdio" | "http";

interface CliOptions {
  transport: TransportMode;
  host: string;
  port: number;
  token?: string;
  password: string;
  askPassword: boolean;
  corsOrigin?: string;
  dbPath?: string;
  debug: boolean;
  actor: string;
}

function envFlag(value: string | undefined): boolean {
  return value === "1" || value?.toLowerCase() === "true";
}

function usage(): string {
  return `crm-mcp 0.1.0

Local-first CRM over MCP, backed by a single SQLite database.

Usage:
  crm-mcp [options]

Options:
  --db <path>           SQLite database path (default: ./crm.db, or CRM_DB_PATH)
  --actor <name>        Audit actor name (default: mcp-client, or CRM_ACTOR)
  --debug               Log every tool call and error to stderr
  --transport <mode>    stdio (default) or http
  --http                Shorthand for --transport http
  --host <host>         HTTP bind address (default: 127.0.0.1)
  --port <port>         HTTP port (default: 8766)
  --password [password] HTTP bearer password (default: Zinnober, or CRM_MCP_PASSWORD).
                        Without a value, a native password prompt opens.
  --ask-password        Open a native password prompt at startup
  --token <token>       HTTP Bearer token (default: HTTP bearer password, or CRM_MCP_TOKEN)
  --cors-origin <list>  Comma-separated allowed browser origins (default: localhost/127.0.0.1)
  -h, --help            Show this help
  -v, --version         Show the version

Environment:
  CRM_DB_PATH, CRM_ACTOR, CRM_MCP_DEBUG, CRM_MCP_TRANSPORT, CRM_MCP_HOST,
  CRM_MCP_PORT, CRM_MCP_PASSWORD, CRM_MCP_TOKEN, CRM_MCP_CORS_ORIGIN

Every write asks for native confirmation and is stored in the audit log.
`;
}

function readOption(
  args: string[],
  index: number,
  name: string,
): { value: string; next: number } {
  const value = args[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`Missing value for ${name}.`);
  }
  return { value, next: index + 2 };
}

function parseOptions(argv: string[]): CliOptions | null {
  const envTransport = process.env.CRM_MCP_TRANSPORT?.toLowerCase();
  const options: CliOptions = {
    transport: envTransport === "http" ? "http" : "stdio",
    host: process.env.CRM_MCP_HOST || "127.0.0.1",
    port: Number.parseInt(process.env.CRM_MCP_PORT || "8766", 10),
    password: process.env.CRM_MCP_PASSWORD || DEFAULT_MCP_PASSWORD,
    token: process.env.CRM_MCP_TOKEN,
    askPassword: false,
    corsOrigin: process.env.CRM_MCP_CORS_ORIGIN,
    dbPath: process.env.CRM_DB_PATH,
    debug: envFlag(process.env.CRM_MCP_DEBUG),
    actor: process.env.CRM_ACTOR || "mcp-client",
  };

  let index = 0;
  while (index < argv.length) {
    const arg = argv[index];
    if (arg === "-h" || arg === "--help") {
      process.stdout.write(usage());
      return null;
    }
    if (arg === "-v" || arg === "--version") {
      process.stdout.write("0.1.0\n");
      return null;
    }
    if (arg === "--http") {
      options.transport = "http";
      index += 1;
      continue;
    }
    if (arg === "--debug") {
      options.debug = true;
      index += 1;
      continue;
    }
    if (arg === "--ask-password") {
      options.askPassword = true;
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
    if (arg === "--db") {
      const parsed = readOption(argv, index, arg);
      options.dbPath = parsed.value;
      index = parsed.next;
      continue;
    }
    if (arg === "--actor") {
      const parsed = readOption(argv, index, arg);
      options.actor = parsed.value;
      index = parsed.next;
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
    throw new Error("CRM_MCP_PORT must be an integer between 1 and 65535.");
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

async function readJsonBody(
  request: IncomingMessage,
  limit = 10 * 1024 * 1024,
): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > limit) throw new Error("Request body is too large.");
    chunks.push(buffer);
  }
  if (!size) return undefined;
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
}

function sendJson(
  response: ServerResponse,
  status: number,
  body: unknown,
): void {
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

function isAllowedOrigin(
  origin: string | undefined,
  configured: string[],
): boolean {
  if (!origin) return false;
  if (configured.includes("*")) return true;
  if (configured.length) return configured.includes(origin);
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
  response.setHeader(
    "Access-Control-Allow-Methods",
    "GET, POST, DELETE, OPTIONS",
  );
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

function closeQuietly(db: ReturnType<typeof openDatabase>): void {
  try {
    closeDatabase(db);
  } catch {
    // Ignore close errors during shutdown.
  }
}

async function runStdio(
  options: CliOptions,
  store: CrmStore,
  db: ReturnType<typeof openDatabase>,
): Promise<void> {
  const server: McpServer = createServer({
    store,
    actor: options.actor,
  });
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[crm-mcp] stdio ready");

  const shutdown = () => {
    void server.close().finally(() => {
      closeQuietly(db);
      process.exit(0);
    });
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

async function runHttp(
  options: CliOptions,
  store: CrmStore,
  db: ReturnType<typeof openDatabase>,
): Promise<void> {
  setDebugEnabled(options.debug);
  const httpToken = options.token || options.password;
  const corsOrigins = resolveCorsOrigins(options.corsOrigin);
  if (!isLoopback(options.host) && !options.token) {
    console.error(
      "[crm-mcp] WARNING: binding to a non-loopback address without an explicit --token/CRM_MCP_TOKEN; using the HTTP bearer password as token.",
    );
  }

  const sessions = new Map<
    string,
    { transport: StreamableHTTPServerTransport; server: McpServer }
  >();

  const httpServer = createHttpServer(async (request, response) => {
    const url = new URL(
      request.url ?? "/",
      `http://${request.headers.host ?? "localhost"}`,
    );
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
        name: "crm-mcp",
        version: "0.1.0",
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
      response.setHeader("WWW-Authenticate", 'Bearer realm="crm-mcp"');
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
    const sessionId =
      typeof rawSessionId === "string" ? rawSessionId : undefined;
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

    const mcp = createServer({ store, actor: options.actor });
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
    `[crm-mcp] HTTP ready at http://${options.host}:${options.port}/mcp`,
  );
  console.error(
    `[crm-mcp] CORS origins: ${
      corsOrigins.length ? corsOrigins.join(", ") : "localhost/127.0.0.1 only"
    }`,
  );

  const shutdown = () => {
    for (const session of sessions.values()) {
      void session.server.close().catch(() => undefined);
    }
    httpServer.close(() => {
      closeQuietly(db);
      process.exit(0);
    });
    setTimeout(() => {
      closeQuietly(db);
      process.exit(0);
    }, 2000).unref();
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  if (!options) return;

  if (options.askPassword) {
    const password = await promptPassword(
      "Set the CRM HTTP bearer password. Leave empty to cancel.",
    );
    if (!password) {
      throw new Error(
        "No password was provided. Set one with --password or CRM_MCP_PASSWORD.",
      );
    }
    options.password = password;
  }

  setDebugEnabled(options.debug);
  const db = openDatabase(resolveDatabasePath(options.dbPath));
  const store = new CrmStore(db, options.actor);
  try {
    if (options.transport === "http") await runHttp(options, store, db);
    else await runStdio(options, store, db);
  } catch (error) {
    closeQuietly(db);
    throw error;
  }
}

main().catch((error: unknown) => {
  console.error(`[crm-mcp] ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
