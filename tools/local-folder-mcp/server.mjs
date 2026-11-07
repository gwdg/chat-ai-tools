#!/usr/bin/env node
// Local, read-only MCP server for accessing user-approved folders.
// Runs over stdio; all logs go to stderr.

import { realpathSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { FolderAccessController } from "./access.mjs";
import { confirmFolderAccess } from "./dialog.mjs";

export const SERVER_INFO = { name: "local-folder-mcp", version: "0.1.0" };
export const PROTOCOL_VERSION = "2025-06-18";

const MAX_CHARS = 100_000;

export const TOOLS = [
  {
    name: "request_folder_access",
    description:
      "Ask the user to allow access to a local folder for this session. A native confirmation dialog shows the exact path. Once allowed for the session, the folder and all subfiles are accessible without further prompts.",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description:
            "Folder path. Absolute, or relative to the MCP server working directory.",
        },
      },
      required: ["path"],
      additionalProperties: false,
    },
  },
  {
    name: "list_folder",
    description:
      "List a local folder. If the folder is not already allowed for this session, the user is asked in a native confirmation dialog first.",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description:
            "Folder path. Absolute, or relative to the MCP server working directory.",
        },
      },
      required: ["path"],
      additionalProperties: false,
    },
  },
  {
    name: "read_file",
    description:
      "Read a UTF-8 text file. If its folder is not already allowed for this session, the user is asked in a native confirmation dialog first. Binary files are rejected.",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description:
            "File path. Absolute, or relative to the MCP server working directory.",
        },
        maxChars: {
          type: "integer",
          minimum: 1,
          maximum: MAX_CHARS,
          description: `Maximum characters to return. Default 20000, maximum ${MAX_CHARS}.`,
        },
      },
      required: ["path"],
      additionalProperties: false,
    },
  },
  {
    name: "list_allowed_folders",
    description:
      "List the folders the user has allowed for this MCP server session.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
];

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

const MAX_HTTP_BODY_BYTES = 2 * 1024 * 1024;

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

/**
 * Streamable HTTP transport for the same MCP server. The client POSTs JSON-RPC
 * messages to /mcp. GET is intentionally 405: this server sends no
 * server-initiated notifications, which is allowed by the transport.
 */
export function createHttpServer({ folderServer, corsOrigins } = {}) {
  if (!folderServer || typeof folderServer.handle !== "function") {
    throw new Error("createHttpServer needs a folder server");
  }

  const origins = corsOrigins ?? resolveCorsOrigins(
    process.env.MCP_FOLDER_CORS_ORIGIN || "",
  );

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

    if (req.method === "GET") {
      res.writeHead(405, { Allow: "POST, DELETE, OPTIONS" });
      res.end();
      return;
    }

    if (req.method === "DELETE") {
      res.writeHead(204);
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

    if (message.id === undefined) {
      res.writeHead(202);
      res.end();
      return;
    }

    try {
      const result = await folderServer.handle(
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

export function createFolderServer({
  dialog = confirmFolderAccess,
  fs,
  cwd = process.cwd(),
  maxEntries,
  maxReadBytes,
} = {}) {
  const controller = new FolderAccessController({
    dialog,
    fs,
    maxEntries,
    maxReadBytes,
  });

  const resolvePath = (input) => {
    if (typeof input !== "string" || !input.trim()) {
      throw new Error("The path argument is required.");
    }
    return path.resolve(cwd, input);
  };

  async function callTool(name, args) {
    try {
      if (name === "request_folder_access") {
        const result = await controller.requestFolderAccess(
          resolvePath(args.path),
        );
        const folders = result.allowedFolders.length
          ? result.allowedFolders.join("\n")
          : "(none)";
        return textResult(
          `Access granted ${result.choice === "session" ? "for this session" : "once"}.\nPath: ${result.path}\nAllowed folders:\n${folders}`,
        );
      }

      if (name === "list_folder") {
        const result = await controller.listFolder(resolvePath(args.path));
        return textResult(
          `${result.entryCount} entries in ${result.path}\n\n${JSON.stringify(result, null, 2)}`,
        );
      }

      if (name === "read_file") {
        const maxChars = clampInteger(args.maxChars, 20000, 1, MAX_CHARS);
        const result = await controller.readFile(resolvePath(args.path), {
          maxChars,
        });
        return textResult(
          `${result.content}${result.truncated ? "\n\n[content truncated]" : ""}`,
        );
      }

      if (name === "list_allowed_folders") {
        const folders = controller.allowedFolders();
        return textResult(folders.length ? folders.join("\n") : "(none)");
      }

      return errorResult(`Unknown tool: ${name}`);
    } catch (error) {
      return errorResult(error?.message || String(error));
    }
  }

  return {
    controller,
    async handle(method, params = {}) {
      switch (method) {
        case "initialize":
          return {
            protocolVersion: params.protocolVersion || PROTOCOL_VERSION,
            capabilities: { tools: {} },
            serverInfo: SERVER_INFO,
            instructions:
              "Local, read-only access to folders the user explicitly allows. Every new folder access opens a native confirmation dialog. Grants are remembered only for this server session.",
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
  const server = createFolderServer({
    maxEntries: Number(process.env.MCP_FOLDER_MAX_ENTRIES) || 1000,
    maxReadBytes: Number(process.env.MCP_FOLDER_MAX_READ_BYTES) || 1_000_000,
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

    if (!message || message.jsonrpc !== "2.0" || typeof message.method !== "string") {
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
        console.error(`local-folder-mcp: ${error?.message || error}`);
      });
    }
  });

  process.stdin.on("end", () => {
    queue.finally(() => process.exit(0));
  });

  process.stdout.on("error", () => process.exit(0));
  process.stdin.on("error", () => process.exit(0));

  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, () => process.exit(0));
  }

  console.error(
    "local-folder-mcp ready (stdio). Folder access requires a native confirmation dialog.",
  );
}

function mainHttp() {
  const folderServer = createFolderServer({
    maxEntries: Number(process.env.MCP_FOLDER_MAX_ENTRIES) || 1000,
    maxReadBytes: Number(process.env.MCP_FOLDER_MAX_READ_BYTES) || 1_000_000,
  });
  const corsOrigins = resolveCorsOrigins(
    process.env.MCP_FOLDER_CORS_ORIGIN || "",
  );
  const httpServer = createHttpServer({ folderServer, corsOrigins });

  const requestedPort = Number(process.env.MCP_FOLDER_HTTP_PORT || 3921);
  const port =
    Number.isInteger(requestedPort) &&
    requestedPort >= 0 &&
    requestedPort <= 65535
      ? requestedPort
      : 3921;

  httpServer.on("error", (error) => {
    console.error(`local-folder-mcp HTTP server error: ${error.message}`);
    process.exit(1);
  });

  httpServer.listen(port, "127.0.0.1", () => {
    const address = httpServer.address();
    const actualPort =
      typeof address === "object" && address ? address.port : port;

    console.log(
      `local-folder-mcp HTTP server listening on 127.0.0.1:${actualPort}`,
    );
    console.log("Use the following MCP endpoint in Chat AI:");
    console.log(`http://127.0.0.1:${actualPort}/mcp`);
    console.log(
      corsOrigins.length
        ? `CORS origins: ${corsOrigins.join(", ")}`
        : "CORS origins: localhost/127.0.0.1 only",
    );
  });

  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, () => {
      httpServer.close(() => process.exit(0));
    });
  }
}

function main() {
  const useHttp =
    process.argv.includes("--http") ||
    process.env.MCP_FOLDER_TRANSPORT === "http";

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
