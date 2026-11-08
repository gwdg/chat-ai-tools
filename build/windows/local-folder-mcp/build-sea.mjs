#!/usr/bin/env node
// Builds a single-file executable for the local folder MCP server with Node SEA.
// Run it on the target OS: Windows builds local-folder-mcp.exe, Linux builds a
// Linux binary for testing.

import { execFileSync } from "node:child_process";
import { chmod, copyFile, mkdir, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

const require = createRequire(import.meta.url);
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(scriptDir, "../../..");
const outDir = path.join(scriptDir, "out");
const isWindows = process.platform === "win32";
const exeName = isWindows ? "local-folder-mcp.exe" : "local-folder-mcp";
const bundlePath = path.join(outDir, "local-folder-mcp.cjs");
const blobPath = path.join(outDir, "sea-prep.blob");
const seaConfigPath = path.join(outDir, "sea-config.json");
const targetExe = path.join(outDir, exeName);
const postjectCli = require.resolve("postject/dist/cli.js");
const SEA_FUSE = "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2";

await rm(outDir, { recursive: true, force: true });
await mkdir(outDir, { recursive: true });

console.log("Bundling the MCP server...");
await build({
  entryPoints: [path.join(root, "tools/local-folder-mcp/server.mjs")],
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node18",
  outfile: bundlePath,
  banner: { js: "process.env.MCP_SEA = '1';" },
  logLevel: "info",
  logOverride: { "empty-import-meta": "silent" },
});

await writeFile(
  seaConfigPath,
  JSON.stringify(
    {
      main: path.basename(bundlePath),
      output: path.basename(blobPath),
      disableExperimentalSEAWarning: true,
    },
    null,
    2,
  ),
);

console.log("Creating the SEA blob...");
execFileSync(
  process.execPath,
  ["--experimental-sea-config", path.basename(seaConfigPath)],
  { cwd: outDir, stdio: "inherit" },
);

console.log("Copying the Node runtime and injecting the blob...");
await copyFile(process.execPath, targetExe);
execFileSync(
  process.execPath,
  [
    postjectCli,
    targetExe,
    "NODE_SEA_BLOB",
    blobPath,
    "--sentinel-fuse",
    SEA_FUSE,
  ],
  { stdio: "inherit" },
);

if (!isWindows) await chmod(targetExe, 0o755);

console.log(`Built ${targetExe}`);
console.log("On Windows this is a standalone local-folder-mcp.exe; it needs no Node installation.");
