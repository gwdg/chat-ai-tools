import { createHash } from "node:crypto";
import { mkdir, readdir, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

import { logError } from "./logging.js";
import type { ParsedMessage } from "./types.js";

export function cacheRoot(): string {
  return process.env.THUNDERBIRD_MCP_CACHE_DIR?.trim() || path.join(process.cwd(), "cache");
}

export function cacheKey(id: string): string {
  return createHash("sha256").update(id).digest("hex").slice(0, 16);
}

function slugify(value: string): string {
  const slug = value
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/g, "");
  return slug || "email";
}

function fileName(message: ParsedMessage): string {
  const date = message.date?.slice(0, 10) || "undated";
  return `${date}_${slugify(message.subject)}_${cacheKey(message.id)}.md`;
}

export async function cacheMessage(message: ParsedMessage): Promise<void> {
  try {
    const root = cacheRoot();
    await mkdir(root, { recursive: true, mode: 0o700 });
    const metadata = {
      cacheVersion: 1,
      id: message.id,
      messageId: message.messageId,
      folder: message.folder,
      folderName: message.folderName,
      date: message.date,
      subject: message.subject,
      from: message.from,
      to: message.to,
      cc: message.cc,
      read: message.read,
      flagged: message.flagged,
      replied: message.replied,
      cachedAt: new Date().toISOString(),
    };
    const content = `---\n${JSON.stringify(metadata, null, 2)}\n---\n\n${message.text}\n`;
    await writeFile(path.join(root, fileName(message)), content, {
      encoding: "utf8",
      mode: 0o600,
    });
  } catch (error) {
    logError("cacheEmail", error);
  }
}

export async function removeCachedMessage(id: string): Promise<void> {
  try {
    const root = cacheRoot();
    const suffix = `_${cacheKey(id)}.md`;
    const entries = await readdir(root);
    await Promise.all(
      entries
        .filter((entry) => entry.endsWith(suffix))
        .map((entry) => unlink(path.join(root, entry))),
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      logError("removeCachedEmail", error);
    }
  }
}
