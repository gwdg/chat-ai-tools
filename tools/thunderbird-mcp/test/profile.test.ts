import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import { profileBaseDirs, selectProfile } from "../src/profile.js";
import type { ProfileCandidate } from "../src/types.js";
import { makeTempDirectory } from "./helpers.js";

function candidate(
  root: string,
  name: string,
  isDefault: boolean,
): ProfileCandidate {
  return { root, name, isDefault, source: "auto" };
}

test("profileBaseDirs includes platform-specific Thunderbird roots", () => {
  const windows = profileBaseDirs({
    platform: "win32",
    appData: "/appdata/roaming",
    home: "/users/example",
  });
  assert.ok(windows.includes(path.join("/appdata/roaming", "Thunderbird")));

  const macos = profileBaseDirs({
    platform: "darwin",
    appData: undefined,
    home: "/users/example",
  });
  assert.ok(
    macos.includes(path.join("/users/example", "Library", "Thunderbird")),
  );

  const linux = profileBaseDirs({
    platform: "linux",
    appData: undefined,
    home: "/home/example",
  });
  assert.ok(linux.includes(path.join("/home/example", ".thunderbird")));
  assert.ok(
    !linux.some((dir) => dir.endsWith(path.join("Library", "Thunderbird"))),
  );
});

test("selectProfile prefers a profile with a live bridge", () => {
  const first = makeTempDirectory();
  const second = makeTempDirectory();
  try {
    const bridge = path.join(second.directory, "thunderbird-mcp-bridge");
    mkdirSync(bridge, { recursive: true });
    writeFileSync(
      path.join(bridge, "status.json"),
      JSON.stringify({ time: Date.now() }),
    );

    const selected = selectProfile([
      candidate(first.directory, "first", true),
      candidate(second.directory, "second", false),
    ]);
    assert.equal(selected?.root, second.directory);
  } finally {
    first.cleanup();
    second.cleanup();
  }
});

test("selectProfile ignores a stale bridge heartbeat", () => {
  const first = makeTempDirectory();
  const second = makeTempDirectory();
  try {
    const stale = path.join(second.directory, "thunderbird-mcp-bridge");
    mkdirSync(stale, { recursive: true });
    writeFileSync(
      path.join(stale, "status.json"),
      JSON.stringify({ time: Date.now() - 60000 }),
    );

    const selected = selectProfile([
      candidate(first.directory, "first", true),
      candidate(second.directory, "second", false),
    ]);
    assert.equal(selected?.root, first.directory);
  } finally {
    first.cleanup();
    second.cleanup();
  }
});
