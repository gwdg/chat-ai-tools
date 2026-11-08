import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import type { ProfileCandidate } from "./types.js";

export function profileBaseDirs({
  platform = process.platform,
  appData = process.env.APPDATA,
  home = homedir(),
}: {
  platform?: NodeJS.Platform;
  appData?: string;
  home?: string;
} = {}): string[] {
  const dirs = [
    path.join(home, ".thunderbird"),
    path.join(home, "snap", "thunderbird", "common", ".thunderbird"),
    path.join(
      home,
      ".var",
      "app",
      "org.mozilla.Thunderbird",
      ".thunderbird",
    ),
    path.join(home, ".mozilla-thunderbird"),
  ];
  if (appData) dirs.push(path.join(appData, "Thunderbird"));
  if (platform === "darwin") {
    dirs.push(path.join(home, "Library", "Thunderbird"));
  }
  return dirs;
}

const PROFILE_BASE_DIRS = profileBaseDirs();

export class UserError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UserError";
  }
}

function expandHome(value: string): string {
  if (value === "~") return homedir();
  if (value.startsWith("~/")) return path.join(homedir(), value.slice(2));
  return value;
}

function parseIni(text: string): Array<Record<string, string>> {
  const sections: Array<Record<string, string>> = [];
  let current: Record<string, string> | undefined;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith(";") || line.startsWith("#")) continue;
    const section = /^\[(.+)]$/.exec(line);
    if (section) {
      current = { __section: section[1] };
      sections.push(current);
      continue;
    }
    if (!current) continue;
    const separator = line.indexOf("=");
    if (separator === -1) continue;
    current[line.slice(0, separator).trim()] = line.slice(separator + 1).trim();
  }
  return sections;
}

function candidatesFromBase(base: string, source: string): ProfileCandidate[] {
  const root = path.resolve(expandHome(base));
  if (!existsSync(root)) return [];

  const found: ProfileCandidate[] = [];
  const seen = new Set<string>();

  const add = (profileRoot: string, name: string, isDefault: boolean) => {
    const resolved = path.resolve(profileRoot);
    if (!existsSync(path.join(resolved, "prefs.js"))) return;
    if (seen.has(resolved)) return;
    seen.add(resolved);
    found.push({ root: resolved, name, isDefault, source });
  };

  if (existsSync(path.join(root, "prefs.js"))) {
    add(root, path.basename(root), true);
  }

  const iniPath = path.join(root, "profiles.ini");
  if (existsSync(iniPath)) {
    try {
      const sections = parseIni(readFileSync(iniPath, "utf8"));
      for (const section of sections) {
        if (!section.__section?.startsWith("Profile")) continue;
        const profilePath = section.Path;
        if (!profilePath) continue;
        const isRelative = section.IsRelative !== "0";
        const resolved = isRelative ? path.join(root, profilePath) : expandHome(profilePath);
        add(resolved, section.Name || path.basename(resolved), section.Default === "1");
      }
    } catch {
      // Fall through to directory scanning.
    }
  }

  if (!found.length) {
    try {
      for (const entry of readdirSync(root, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        add(path.join(root, entry.name), entry.name, false);
      }
    } catch {
      // Ignore unreadable directories.
    }
  }

  return found;
}

function dedupeCandidates(candidates: ProfileCandidate[]): ProfileCandidate[] {
  const seen = new Set<string>();
  const result: ProfileCandidate[] = [];
  for (const candidate of candidates) {
    if (seen.has(candidate.root)) continue;
    seen.add(candidate.root);
    result.push(candidate);
  }
  return result;
}

export function discoverProfiles(explicitProfile?: string): ProfileCandidate[] {
  const candidates: ProfileCandidate[] = [];
  const explicit = explicitProfile ?? process.env.THUNDERBIRD_PROFILE;
  if (explicit) {
    candidates.push(...candidatesFromBase(explicit, explicitProfile ? "explicit" : "env"));
  }
  for (const base of PROFILE_BASE_DIRS) {
    candidates.push(...candidatesFromBase(base, "auto"));
  }
  const deduped = dedupeCandidates(candidates);
  return deduped.sort((a, b) => {
    if (a.source !== b.source) {
      if (a.source === "explicit") return -1;
      if (b.source === "explicit") return 1;
      if (a.source === "env") return -1;
      if (b.source === "env") return 1;
    }
    if (a.isDefault !== b.isDefault) return a.isDefault ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}

const FRESHNESS_MAX_DEPTH = 8;
const FRESHNESS_CACHE_TTL = 10_000;
const freshnessCache = new Map<string, { at: number; value: number }>();

function newestMtime(directory: string, depth: number): number {
  if (depth > FRESHNESS_MAX_DEPTH) return 0;
  let entries;
  try {
    entries = readdirSync(directory, { withFileTypes: true });
  } catch {
    return 0;
  }
  let newest = 0;
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "cur" || entry.name === "new" || entry.name === "tmp") continue;
      newest = Math.max(newest, newestMtime(fullPath, depth + 1));
    } else if (entry.isFile()) {
      try {
        newest = Math.max(newest, statSync(fullPath).mtimeMs);
      } catch {
        // Ignore files that disappear during the scan.
      }
    }
  }
  return newest;
}

function profileFreshness(profileRoot: string): number {
  let newest = 0;
  for (const subdirectory of ["Mail", "ImapMail"]) {
    newest = Math.max(newest, newestMtime(path.join(profileRoot, subdirectory), 0));
  }
  return newest;
}

function cachedProfileFreshness(profileRoot: string): number {
  const cached = freshnessCache.get(profileRoot);
  if (cached && Date.now() - cached.at < FRESHNESS_CACHE_TTL) return cached.value;
  const value = profileFreshness(profileRoot);
  freshnessCache.set(profileRoot, { at: Date.now(), value });
  return value;
}

export function bridgeIsLive(profileRoot: string): boolean {
  const base = path.join(profileRoot, "thunderbird-mcp-bridge");
  try {
    const status = JSON.parse(
      readFileSync(path.join(base, "status.json"), "utf8"),
    ) as { time?: unknown };
    if (
      typeof status.time === "number" &&
      Date.now() - status.time < 5000
    ) {
      return true;
    }
  } catch {
    // No usable heartbeat.
  }
  return false;
}

function pickByFreshness(pool: ProfileCandidate[]): ProfileCandidate {
  let selected = pool[0];
  let newest = cachedProfileFreshness(selected.root);
  for (const candidate of pool.slice(1)) {
    const freshness = cachedProfileFreshness(candidate.root);
    if (freshness > newest) {
      selected = candidate;
      newest = freshness;
    }
  }
  return selected;
}

export function selectProfile(candidates: ProfileCandidate[]): ProfileCandidate | undefined {
  if (!candidates.length) return undefined;

  const live = candidates.filter((candidate) => bridgeIsLive(candidate.root));
  if (live.length) {
    const liveDefaults = live.filter((candidate) => candidate.isDefault);
    return pickByFreshness(liveDefaults.length ? liveDefaults : live);
  }

  const topSource = candidates[0].source;
  const sourcePool = candidates.filter((candidate) => candidate.source === topSource);
  const defaultPool = sourcePool.filter((candidate) => candidate.isDefault);
  return pickByFreshness(defaultPool.length ? defaultPool : sourcePool);
}
