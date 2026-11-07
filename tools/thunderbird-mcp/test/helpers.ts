import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const FIXTURE_PROFILE = fileURLToPath(new URL("./fixtures/profile", import.meta.url));

export function makeTempProfile(): { root: string; cleanup: () => void } {
  const directory = mkdtempSync(path.join(tmpdir(), "thunderbird-mcp-"));
  const root = path.join(directory, "profile");
  cpSync(FIXTURE_PROFILE, root, { recursive: true });
  return {
    root,
    cleanup: () => rmSync(directory, { recursive: true, force: true }),
  };
}

export function makeTempDirectory(): { directory: string; cleanup: () => void } {
  const directory = mkdtempSync(path.join(tmpdir(), "thunderbird-mcp-"));
  return {
    directory,
    cleanup: () => rmSync(directory, { recursive: true, force: true }),
  };
}
