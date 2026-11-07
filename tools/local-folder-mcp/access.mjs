import fs from "node:fs/promises";
import path from "node:path";

export class AccessDeniedError extends Error {
  constructor(target) {
    super(`Access denied by the user: ${target}`);
    this.name = "AccessDeniedError";
  }
}

export class PathError extends Error {
  constructor(message) {
    super(message);
    this.name = "PathError";
  }
}

function normalizeForCompare(value) {
  return process.platform === "win32" ? value.toLowerCase() : value;
}

export function isWithin(root, candidate) {
  const relative = path.relative(
    normalizeForCompare(path.resolve(root)),
    normalizeForCompare(path.resolve(candidate)),
  );

  return (
    relative === "" ||
    (relative !== ".." &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative))
  );
}

/**
 * Session-scoped access control for local folders.
 *
 * A granted root covers the folder and everything below it. The browser/client
 * never decides this; the native dialog does, and the decision is kept only in
 * this process.
 */
export class FolderAccessController {
  constructor({
    dialog,
    fs: fsImpl = fs,
    maxEntries = 1000,
    maxReadBytes = 1_000_000,
  } = {}) {
    if (typeof dialog !== "function") {
      throw new Error("FolderAccessController needs a dialog function");
    }

    this.dialog = dialog;
    this.fs = fsImpl;
    this.maxEntries = Math.max(1, Number(maxEntries) || 1000);
    this.maxReadBytes = Math.max(1, Number(maxReadBytes) || 1_000_000);
    this.roots = new Set();
  }

  allowedFolders() {
    return [...this.roots];
  }

  isAllowed(realPath) {
    for (const root of this.roots) {
      if (isWithin(root, realPath)) return true;
    }
    return false;
  }

  async resolveExisting(pathInput) {
    if (typeof pathInput !== "string" || !pathInput.trim()) {
      throw new PathError("A path is required.");
    }

    const absolute = path.resolve(pathInput);
    try {
      return await this.fs.realpath(absolute);
    } catch {
      throw new PathError(`Path not found: ${absolute}`);
    }
  }

  async ensureAccess({ realPath, root, action, displayPath }) {
    if (this.isAllowed(realPath)) return "session";

    const choice = await this.dialog({
      title: "Local folder access request",
      action,
      path: displayPath || realPath,
      root,
    });

    if (choice === "session") {
      this.roots.add(root);
      return "session";
    }
    if (choice === "once") return "once";

    throw new AccessDeniedError(displayPath || realPath);
  }

  async requestFolderAccess(pathInput) {
    const realPath = await this.resolveExisting(pathInput);
    const stats = await this.fs.stat(realPath);
    if (!stats.isDirectory()) {
      throw new PathError(`Not a folder: ${realPath}`);
    }

    const choice = await this.ensureAccess({
      realPath,
      root: realPath,
      action: "access this folder",
      displayPath: realPath,
    });

    return {
      path: realPath,
      choice,
      allowedFolders: this.allowedFolders(),
    };
  }

  async listFolder(pathInput) {
    const requestedPath = path.resolve(pathInput);
    const realPath = await this.resolveExisting(pathInput);
    const stats = await this.fs.stat(realPath);
    if (!stats.isDirectory()) {
      throw new PathError(`Not a folder: ${realPath}`);
    }

    await this.ensureAccess({
      realPath,
      root: realPath,
      action: "list this folder",
      displayPath: realPath,
    });

    const entries = await this.fs.readdir(realPath, { withFileTypes: true });
    const limited = entries.slice(0, this.maxEntries);
    const items = await Promise.all(
      limited.map(async (entry) => {
        const fullPath = path.join(realPath, entry.name);
        const item = {
          name: entry.name,
          type: entry.isDirectory()
            ? "directory"
            : entry.isSymbolicLink()
              ? "symlink"
              : "file",
        };

        try {
          const entryStats = await this.fs.lstat(fullPath);
          item.size = entryStats.size;
          item.modified = entryStats.mtime.toISOString();
          if (entryStats.isSymbolicLink()) item.type = "symlink";
        } catch {
          // Keep the entry even when its metadata cannot be read.
        }

        return item;
      }),
    );

    items.sort((a, b) => a.name.localeCompare(b.name));

    return {
      requestedPath,
      path: realPath,
      cwd: process.cwd(),
      entryCount: items.length,
      entries: items,
      truncated: entries.length > this.maxEntries,
    };
  }

  async readFile(pathInput, { maxChars = 20000 } = {}) {
    const realPath = await this.resolveExisting(pathInput);
    const stats = await this.fs.stat(realPath);
    if (!stats.isFile()) {
      throw new PathError(`Not a file: ${realPath}`);
    }

    const root = path.dirname(realPath);
    await this.ensureAccess({
      realPath,
      root,
      action: "read this file",
      displayPath: realPath,
    });

    const bytesToRead = Math.min(stats.size, this.maxReadBytes);
    const buffer = Buffer.alloc(bytesToRead);
    const handle = await this.fs.open(realPath, "r");

    try {
      await handle.read(buffer, 0, bytesToRead, 0);
    } finally {
      await handle.close();
    }

    if (buffer.subarray(0, Math.min(buffer.length, 8000)).includes(0)) {
      throw new PathError(`Binary file is not supported: ${realPath}`);
    }

    let content = buffer.toString("utf8");
    let truncated = stats.size > bytesToRead;

    const limit = Math.max(1, Number(maxChars) || 20000);
    if (content.length > limit) {
      content = content.slice(0, limit);
      truncated = true;
    }

    return {
      path: realPath,
      content,
      truncated,
    };
  }
}
