#!/usr/bin/env node
// Minimal proxy for Chat AI / SAIA.
//
// It keeps the API key on the server, adds CORS headers for local development,
// and forwards only the model list and chat completion endpoints.
//
// Configuration: secrets/back.json (see secrets/back.json.example), or set
// CONFIG_LOCATION to another file. PORT and CORS_ORIGIN can override the config.

import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { Readable } from "node:stream";

import { applyBackendModel } from "./model-override.mjs";

const configPath = process.env.CONFIG_LOCATION
  ? path.resolve(process.env.CONFIG_LOCATION)
  : path.resolve(process.cwd(), "secrets", "back.json");

let config;
try {
  config = JSON.parse(fs.readFileSync(configPath, "utf8"));
} catch (error) {
  console.error(`Cannot read ${configPath}: ${error.message}`);
  console.error("Copy secrets/back.json.example to secrets/back.json and add your API key.");
  process.exit(1);
}

const apiEndpoint = String(config.apiEndpoint || "").replace(/\/+$/, "");
const apiKey = String(config.apiKey || "").trim();
const serviceName = String(config.serviceName || "Chat AI Tools");
const model = String(config.model || "").trim();
const port = Number(process.env.PORT || config.port || 8081);
const corsOrigin = process.env.CORS_ORIGIN || config.corsOrigin || "*";

if (!apiEndpoint) {
  console.error("back.json needs an apiEndpoint, e.g. https://chat-ai.academiccloud.de/v1");
  process.exit(1);
}
if (!apiKey) {
  console.error("back.json needs an apiKey");
  process.exit(1);
}

const MAX_BODY_BYTES = 2 * 1024 * 1024;

function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", corsOrigin);
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type, Accept");
  res.setHeader("Access-Control-Max-Age", "600");
}

function json(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
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

async function forward(req, res, target, body) {
  const headers = {
    Authorization: `Bearer ${apiKey}`,
    "inference-portal": serviceName,
  };
  if (body !== null) {
    headers["Content-Type"] = req.headers["content-type"] || "application/json";
  }
  if (req.headers.accept) headers.Accept = req.headers.accept;

  const upstream = await fetch(target, {
    method: req.method,
    headers,
    body,
  });

  res.statusCode = upstream.status;

  for (const [key, value] of upstream.headers) {
    const name = key.toLowerCase();
    if (["content-type", "cache-control"].includes(name)) {
      res.setHeader(key, value);
    }
  }

  if (!upstream.body) {
    res.end();
    return;
  }

  Readable.fromWeb(upstream.body).pipe(res);
}

const server = http.createServer(async (req, res) => {
  const startedAt = Date.now();
  setCors(res);

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);

  try {
    if (req.method === "GET" && ["/health", "/v1/health"].includes(url.pathname)) {
      json(res, 200, { ok: true });
      return;
    }

    if (req.method === "GET" && ["/models", "/v1/models"].includes(url.pathname)) {
      await forward(req, res, `${apiEndpoint}/models`, null);
      return;
    }

    if (
      req.method === "POST" &&
      ["/chat/completions", "/v1/chat/completions"].includes(url.pathname)
    ) {
      const rawBody = await readBody(req);
      let body;
      try {
        body = applyBackendModel(rawBody, model);
      } catch (error) {
        json(res, 400, { error: error.message });
        return;
      }
      await forward(req, res, `${apiEndpoint}/chat/completions`, body);
      return;
    }

    json(res, 404, { error: "Not found" });
  } catch (error) {
    if (!res.headersSent) {
      json(res, 502, { error: error?.message || String(error) });
    } else {
      res.destroy();
    }
  } finally {
    console.log(
      `${req.method} ${url.pathname} -> ${res.statusCode} (${Date.now() - startedAt} ms)`,
    );
  }
});

server.listen(port, () => {
  console.log(`Chat AI proxy listening on http://localhost:${port}`);
  console.log(`Forwarding to ${apiEndpoint}`);
  console.log(`Model: ${model || "(from request)"}`);
});
