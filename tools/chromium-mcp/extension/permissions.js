export const SNAPSHOT_ATTR = "data-chromium-mcp-id";
export const SESSION_GRANTS_KEY = "grants";

export function originOf(url) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    return parsed.origin;
  } catch {
    return null;
  }
}

export function tabGrantKey(tabId, url) {
  const origin = originOf(url);
  if (!Number.isInteger(tabId) || !origin) return null;
  return `${tabId}|${origin}`;
}

export function isControllableUrl(url) {
  return originOf(url) !== null;
}

export function normalizeNavigationUrl(input) {
  if (typeof input !== "string" || !input.trim()) {
    throw new Error("The url argument is required.");
  }
  let parsed;
  try {
    parsed = new URL(input.trim());
  } catch {
    throw new Error("Use an absolute http:// or https:// URL.");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(
      `Blocked URL scheme "${parsed.protocol}". Only http and https are allowed.`,
    );
  }
  return parsed.toString();
}
