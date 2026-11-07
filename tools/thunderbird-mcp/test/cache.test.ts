import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { cacheMessage, removeCachedMessage } from "../src/cache.js";
import type { ParsedMessage } from "../src/types.js";

test("caches a message and deletes it when marked unread", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "thunderbird-mcp-cache-"));
  const previous = process.env.THUNDERBIRD_MCP_CACHE_DIR;
  process.env.THUNDERBIRD_MCP_CACHE_DIR = dir;
  t.after(async () => {
    if (previous === undefined) delete process.env.THUNDERBIRD_MCP_CACHE_DIR;
    else process.env.THUNDERBIRD_MCP_CACHE_DIR = previous;
    await rm(dir, { recursive: true, force: true });
  });

  const message = {
    id: "message-id",
    messageId: "abc@example.com",
    folder: "account6://INBOX",
    folderName: "INBOX",
    index: 0,
    subject: "Deadline: 31.10.2026",
    from: [{ name: "Alice", email: "alice@example.com" }],
    to: [{ name: "Bob", email: "bob@example.com" }],
    cc: [],
    bcc: [],
    replyTo: [],
    date: "2026-10-27T10:00:00.000Z",
    dateRaw: "Tue, 27 Oct 2026 10:00:00 GMT",
    inReplyTo: null,
    references: [],
    text: "Bitte bis zum 31.10.2026 einreichen.",
    attachments: [],
    read: false,
    flagged: false,
    replied: false,
    headers: {},
  } satisfies ParsedMessage;

  await cacheMessage(message);
  const files = await readdir(dir);
  assert.equal(files.length, 1);
  assert.match(files[0], /^2026-10-27_Deadline-31-10-2026_[0-9a-f]{16}\.md$/);

  const content = await readFile(path.join(dir, files[0]), "utf8");
  assert.match(content, /"id": "message-id"/);
  assert.match(content, /Bitte bis zum 31\.10\.2026 einreichen\./);

  await removeCachedMessage(message.id);
  assert.deepEqual(await readdir(dir), []);
});
