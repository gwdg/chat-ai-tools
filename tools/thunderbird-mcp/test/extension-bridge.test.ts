import assert from "node:assert/strict";
import {
  mkdirSync,
  readFileSync,
  readdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer, type Socket } from "node:net";
import path from "node:path";
import test from "node:test";

import {
  extensionAvailable,
  markViaExtension,
} from "../src/extension-bridge.js";
import { makeTempDirectory } from "./helpers.js";

test("detects a fresh extension heartbeat and ignores stale ones", async () => {
  const temp = makeTempDirectory();
  try {
    const base = path.join(temp.directory, "thunderbird-mcp-bridge");
    mkdirSync(base, { recursive: true });
    const status = path.join(base, "status.json");

    writeFileSync(status, JSON.stringify({ time: Date.now() - 10000 }));
    assert.equal(await extensionAvailable(temp.directory), false);

    writeFileSync(status, JSON.stringify({ time: Date.now() }));
    assert.equal(await extensionAvailable(temp.directory), true);
  } finally {
    temp.cleanup();
  }
});

test("sends a mark command through the extension bridge", async () => {
  const temp = makeTempDirectory();
  const base = path.join(temp.directory, "thunderbird-mcp-bridge");
  const commands = path.join(base, "commands");
  const results = path.join(base, "results");
  mkdirSync(commands, { recursive: true });
  mkdirSync(results, { recursive: true });
  writeFileSync(path.join(base, "status.json"), JSON.stringify({ time: Date.now() }));

  const timer = setInterval(() => {
    let names: string[];
    try {
      names = readdirSync(commands);
    } catch {
      return;
    }
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      const file = path.join(commands, name);
      try {
        const command = JSON.parse(readFileSync(file, "utf8")) as {
          id: string;
          command?: string;
          read?: boolean;
          answered?: boolean;
        };
        unlinkSync(file);
        writeFileSync(
          path.join(results, name),
          JSON.stringify({
            id: command.id,
            ok: true,
            result: { read: command.read, answered: command.answered },
          }),
        );
      } catch {
        // Ignore partially written files.
      }
    }
  }, 50);

  try {
    const result = await markViaExtension(
      temp.directory,
      "message@example.com",
      true,
      true,
    );
    assert.equal(result.attempted, true);
    assert.equal(result.ok, true);
    assert.deepEqual(result.result, { read: true, answered: true });
  } finally {
    clearInterval(timer);
    temp.cleanup();
  }
});

test("uses the Unix socket bridge when available", async () => {
  const temp = makeTempDirectory();
  const base = path.join(temp.directory, "thunderbird-mcp-bridge");
  mkdirSync(base, { recursive: true });
  const socketPath = path.join(base, "mcp.sock");

  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk.toString();
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf("\n");
        if (!line) continue;
        const command = JSON.parse(line) as {
          id: string;
          command: string;
          read?: boolean;
          answered?: boolean;
        };
        const result =
          command.command === "ping"
            ? { socket: true }
            : { read: command.read, answered: command.answered };
        socket.write(
          `${JSON.stringify({ id: command.id, ok: true, result })}\n`,
        );
      }
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => resolve());
  });
  writeFileSync(
    path.join(base, "socket.json"),
    JSON.stringify({ path: socketPath, time: Date.now() }),
  );

  try {
    assert.equal(await extensionAvailable(temp.directory), true);
    const result = await markViaExtension(
      temp.directory,
      "message@example.com",
      true,
      true,
    );
    assert.equal(result.attempted, true);
    assert.equal(result.ok, true);
    assert.deepEqual(result.result, { read: true, answered: true });
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    temp.cleanup();
  }
});
