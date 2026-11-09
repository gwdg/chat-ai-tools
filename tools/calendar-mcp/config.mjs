import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

export function resolveConfigPath(value) {
  return path.resolve(
    value || process.env.CALENDAR_CONFIG || "./secrets/calendar.json",
  );
}

export function assertAllowedBaseUrl(value, field = "baseUrl") {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${field} is required.`);
  }
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${field} must be an absolute URL.`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error(`${field} must use http or https.`);
  }
  if (url.protocol === "http:" && !LOOPBACK_HOSTS.has(url.hostname)) {
    throw new Error(
      `${field} must use https, except for localhost/127.0.0.1 testing.`,
    );
  }
  return url.toString();
}

function optionalNonEmpty(value) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

export function validateConfig(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("Calendar config must be a JSON object.");
  }

  const baseUrl = assertAllowedBaseUrl(raw.baseUrl);
  const username = optionalNonEmpty(raw.username);
  const password = optionalNonEmpty(raw.password);
  const email = optionalNonEmpty(raw.email);
  if (!username) throw new Error("username is required.");
  if (!password) throw new Error("password is required.");
  if (!email || !/^[^\s@]+@[^\s@]+$/.test(email)) {
    throw new Error("email must be a valid email address.");
  }

  const baseOrigin = new URL(baseUrl).origin;
  const sameOrigin = (value, field) => {
    const url = new URL(assertAllowedBaseUrl(value, field));
    if (url.origin !== baseOrigin) {
      throw new Error(`${field} must use the same origin as baseUrl.`);
    }
    return url.toString();
  };

  let calendarHome = "";
  if (optionalNonEmpty(raw.calendarHome)) {
    calendarHome = sameOrigin(raw.calendarHome, "calendarHome");
  }

  let calendars;
  if (raw.calendars !== undefined) {
    if (!Array.isArray(raw.calendars) || !raw.calendars.length) {
      throw new Error("calendars must be a non-empty array when provided.");
    }
    calendars = raw.calendars.map((entry, index) => {
      if (!entry || typeof entry !== "object") {
        throw new Error(`calendars[${index}] must be an object.`);
      }
      const url = sameOrigin(entry.url, `calendars[${index}].url`);
      return {
        name: optionalNonEmpty(entry.name) || `Calendar ${index + 1}`,
        url,
        readOnly: entry.readOnly === true,
      };
    });
  }

  const timeoutMs = Number(raw.timeoutMs);
  return {
    baseUrl,
    username,
    password,
    email: email.toLowerCase(),
    displayName: optionalNonEmpty(raw.displayName),
    calendarHome,
    calendars,
    defaultCalendar: optionalNonEmpty(raw.defaultCalendar),
    readOnly: raw.readOnly === true,
    timeoutMs:
      Number.isFinite(timeoutMs) && timeoutMs >= 1000
        ? Math.min(Math.trunc(timeoutMs), 120_000)
        : 30_000,
  };
}

export function loadConfig(location) {
  const configPath = resolveConfigPath(location);
  if (!existsSync(configPath)) {
    throw new Error(
      `Calendar config not found: ${configPath}. Copy secrets/calendar.json.example and edit it.`,
    );
  }
  let raw;
  try {
    raw = JSON.parse(readFileSync(configPath, "utf8"));
  } catch (error) {
    throw new Error(
      `Could not parse calendar config ${configPath}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  return { ...validateConfig(raw), configPath };
}
