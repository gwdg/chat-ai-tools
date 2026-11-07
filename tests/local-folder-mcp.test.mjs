import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  AccessDeniedError,
  FolderAccessController,
  isWithin,
} from "../tools/local-folder-mcp/access.mjs";
import {
  createFolderServer,
  SERVER_INFO,
} from "../tools/local-folder-mcp/server.mjs";

async function withTree(run) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-folder-"));
  try {
    await fs.mkdir(path.join(root, "sub"));
    await fs.writeFile(path.join(root, "a.txt"), "hello");
    await fs.writeFile(path.join(root, "sub", "b.txt"), "nested");
    return await run(root);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

function dialogReturning(...choices) {
  const calls = [];
  let index = 0;
  const dialog = async (request) => {
    calls.push(request);
    const choice = choices[Math.min(index, choices.length - 1)] ?? "deny";
    index += 1;
    return choice;
  };
  return { dialog, calls };
}

test("denies access when the dialog says no", async () => {
  await withTree(async (root) => {
    const { dialog, calls } = dialogReturning("deny");
    const controller = new FolderAccessController({ dialog });

    await assert.rejects(
      () => controller.listFolder(root),
      (error) => error instanceof AccessDeniedError && /Access denied/.test(error.message),
    );
    assert.equal(calls.length, 1);
    assert.deepEqual(controller.allowedFolders(), []);
  });
});

test("allows once without remembering the folder", async () => {
  await withTree(async (root) => {
    const { dialog, calls } = dialogReturning("once");
    const controller = new FolderAccessController({ dialog });
    const file = path.join(root, "a.txt");

    const first = await controller.readFile(file);
    assert.equal(first.content, "hello");
    assert.deepEqual(controller.allowedFolders(), []);

    const second = await controller.readFile(file);
    assert.equal(second.content, "hello");
    assert.equal(calls.length, 2);
  });
});

test("remembers a granted folder for the session", async () => {
  await withTree(async (root) => {
    const { dialog, calls } = dialogReturning("session");
    const controller = new FolderAccessController({ dialog });

    await controller.readFile(path.join(root, "a.txt"));
    await controller.readFile(path.join(root, "sub", "b.txt"));

    assert.equal(calls.length, 1);
    assert.equal(controller.allowedFolders().length, 1);
  });
});

test("granting a subfolder does not grant its parent", async () => {
  await withTree(async (root) => {
    const { dialog, calls } = dialogReturning("session", "deny");
    const controller = new FolderAccessController({ dialog });
    const sub = path.join(root, "sub");

    await controller.requestFolderAccess(sub);
    await controller.readFile(path.join(sub, "b.txt"));
    assert.equal(calls.length, 1);

    await assert.rejects(
      () => controller.readFile(path.join(root, "a.txt")),
      /Access denied/,
    );
    assert.equal(calls.length, 2);
  });
});

test("lists entries with type and size", async () => {
  await withTree(async (root) => {
    const { dialog } = dialogReturning("session");
    const controller = new FolderAccessController({ dialog });

    const result = await controller.listFolder(root);
    assert.equal(result.path, await fs.realpath(root));
    assert.equal(result.requestedPath, path.resolve(root));
    assert.equal(result.entryCount, 2);
    assert.deepEqual(
      result.entries.map((entry) => entry.name),
      ["a.txt", "sub"],
    );
    assert.equal(result.entries[0].type, "file");
    assert.equal(result.entries[0].size, 5);
    assert.equal(result.entries[1].type, "directory");
  });
});

test("rejects binary files", async () => {
  await withTree(async (root) => {
    const bin = path.join(root, "bin.dat");
    await fs.writeFile(bin, Buffer.from([0, 1, 2, 3]));
    const { dialog } = dialogReturning("session");
    const controller = new FolderAccessController({ dialog });

    await assert.rejects(() => controller.readFile(bin), /Binary file/);
  });
});

test("truncates file content to maxChars", async () => {
  await withTree(async (root) => {
    const { dialog } = dialogReturning("session");
    const controller = new FolderAccessController({ dialog });

    const result = await controller.readFile(path.join(root, "a.txt"), {
      maxChars: 2,
    });
    assert.equal(result.content, "he");
    assert.equal(result.truncated, true);
  });
});

test("reports missing paths without opening a dialog", async () => {
  await withTree(async (root) => {
    const { dialog, calls } = dialogReturning("session");
    const controller = new FolderAccessController({ dialog });

    await assert.rejects(
      () => controller.readFile(path.join(root, "missing.txt")),
      /Path not found/,
    );
    assert.equal(calls.length, 0);
  });
});

test("checks path containment without prefix bugs", () => {
  assert.equal(isWithin("/a/b", "/a/b/c"), true);
  assert.equal(isWithin("/a/b", "/a/b"), true);
  assert.equal(isWithin("/a/b", "/a/bc"), false);
  assert.equal(isWithin("/a/b", "/a/b/..foo"), true);
});

test("serves MCP initialize, tool listing, and tool calls", async () => {
  await withTree(async (root) => {
    const { dialog, calls } = dialogReturning("session");
    const server = createFolderServer({ dialog, cwd: root });

    const initialized = await server.handle("initialize", {
      protocolVersion: "2025-06-18",
    });
    assert.equal(initialized.serverInfo.name, SERVER_INFO.name);
    assert.equal(initialized.protocolVersion, "2025-06-18");

    const listed = await server.handle("tools/list");
    assert.deepEqual(
      listed.tools.map((tool) => tool.name),
      [
        "request_folder_access",
        "list_folder",
        "read_file",
        "list_allowed_folders",
      ],
    );

    const folder = await server.handle("tools/call", {
      name: "list_folder",
      arguments: { path: "." },
    });
    assert.equal(folder.isError, undefined);
    assert.match(folder.content[0].text, /a\.txt/);
    assert.equal(calls.length, 1);

    const file = await server.handle("tools/call", {
      name: "read_file",
      arguments: { path: "a.txt" },
    });
    assert.equal(file.content[0].text, "hello");
    assert.equal(calls.length, 1);

    const allowed = await server.handle("tools/call", {
      name: "list_allowed_folders",
      arguments: {},
    });
    assert.match(allowed.content[0].text, /mcp-folder-/);

    const unknown = await server.handle("tools/call", {
      name: "not_a_tool",
      arguments: {},
    });
    assert.equal(unknown.isError, true);
  });
});

test("returns MCP errors for unknown methods and denied tools", async () => {
  await withTree(async (root) => {
    const denied = createFolderServer({
      dialog: dialogReturning("deny").dialog,
      cwd: root,
    });

    await assert.rejects(
      () => denied.handle("resources/list"),
      (error) => error.code === -32601,
    );

    const result = await denied.handle("tools/call", {
      name: "read_file",
      arguments: { path: "a.txt" },
    });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /Access denied/);
  });
});
