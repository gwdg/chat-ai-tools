import iconv from "iconv-lite";

import type { EmailAddress } from "./types.js";

const ENCODED_WORD = /=\?([^?]+)\?([bBqQ])\?([^?]*)\?=/g;
const UNSAFE_TEXT =
  /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u200B-\u200F\u202A-\u202E\u2060-\u2069\u{E0000}-\u{E007F}]/gu;

export function sanitizeUntrustedText(value: string): string {
  return value.replace(UNSAFE_TEXT, "");
}

export function sanitizeHeaderText(value: string): string {
  return sanitizeUntrustedText(value).replace(/[\r\n]+/g, " ");
}

function normalizeCharset(charset: string): string {
  const value = charset.trim().toLowerCase();
  if (value === "utf8") return "utf-8";
  if (value === "latin1" || value === "latin-1") return "iso-8859-1";
  if (value === "cp1252") return "windows-1252";
  return value;
}

function decodeQ(text: string): Buffer {
  const bytes: number[] = [];
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (char === "_") {
      bytes.push(0x20);
      continue;
    }
    if (char === "=" && /^[0-9a-fA-F]{2}$/.test(text.slice(i + 1, i + 3))) {
      bytes.push(Number.parseInt(text.slice(i + 1, i + 3), 16));
      i += 2;
      continue;
    }
    bytes.push(char.charCodeAt(0) & 0xff);
  }
  return Buffer.from(bytes);
}

export function decodeWords(input: string): string {
  if (!input.includes("=?")) return sanitizeHeaderText(input);
  return sanitizeHeaderText(
    input.replace(ENCODED_WORD, (match, charset: string, encoding: string, text: string) => {
      try {
        const bytes = encoding.toUpperCase() === "B" ? Buffer.from(text, "base64") : decodeQ(text);
        return iconv.decode(bytes, normalizeCharset(charset));
      } catch {
        return match;
      }
    }),
  );
}

export function unfoldHeaders(block: string): string {
  return block.replace(/\r?\n[ \t]+/g, " ");
}

export function foldHeaderLine(line: string, limit = 78): string {
  if (line.length <= limit) return line;
  const parts: string[] = [];
  let current = line;
  while (current.length > limit) {
    let splitAt = current.lastIndexOf(" ", limit);
    if (splitAt <= 0) splitAt = current.indexOf(" ");
    if (splitAt <= 0) break;
    parts.push(current.slice(0, splitAt));
    current = current.slice(splitAt + 1);
  }
  parts.push(current);
  return parts.join("\n ");
}

export function encodeHeaderValue(value: string): string {
  if (!/[^\x20-\x7e]/.test(value)) return value;
  const encoded: string[] = [];
  let chunk = "";
  for (const char of value) {
    if (Buffer.byteLength(chunk + char, "utf8") > 45) {
      encoded.push(`=?UTF-8?B?${Buffer.from(chunk, "utf8").toString("base64")}?=`);
      chunk = "";
    }
    chunk += char;
  }
  if (chunk) encoded.push(`=?UTF-8?B?${Buffer.from(chunk, "utf8").toString("base64")}?=`);
  return encoded.join(" ");
}

function quoteDisplayName(name: string): string {
  if (/[^\x20-\x7e]/.test(name)) return encodeHeaderValue(name);
  if (/[",<>@;:\\]/.test(name)) return `"${name.replace(/(["\\])/g, "\\$1")}"`;
  return name;
}

export function formatAddress(address: EmailAddress): string {
  const email = address.email.trim();
  const name = address.name?.trim();
  if (!name || name === email) return email;
  return `${quoteDisplayName(name)} <${email}>`;
}

export function formatAddressList(addresses: EmailAddress[]): string {
  return addresses.filter((item) => item.email.trim()).map(formatAddress).join(", ");
}

function splitAddressList(value: string): string[] {
  const parts: string[] = [];
  let current = "";
  let inQuotes = false;
  let angleDepth = 0;
  for (let i = 0; i < value.length; i += 1) {
    const char = value[i];
    if (char === "\\" && inQuotes) {
      current += char + (value[i + 1] ?? "");
      i += 1;
      continue;
    }
    if (char === '"') {
      inQuotes = !inQuotes;
      current += char;
      continue;
    }
    if (!inQuotes && char === "<") angleDepth += 1;
    if (!inQuotes && char === ">" && angleDepth > 0) angleDepth -= 1;
    if (char === "," && !inQuotes && angleDepth === 0) {
      if (current.trim()) parts.push(current.trim());
      current = "";
      continue;
    }
    current += char;
  }
  if (current.trim()) parts.push(current.trim());
  return parts;
}

export function parseAddressList(value: string | undefined): EmailAddress[] {
  if (!value) return [];
  const decoded = decodeWords(value);
  return splitAddressList(decoded)
    .map((part) => {
      const angle = /^(.*?)[<(]([^<>()]+)[>)]\s*$/.exec(part);
      if (angle) {
        const name = sanitizeHeaderText(angle[1])
          .trim()
          .replace(/^"|"$/g, "")
          .replace(/\\(["\\])/g, "$1");
        const email = sanitizeHeaderText(angle[2]).replace(/[\s<>]/g, "");
        if (!email) return null;
        return { name: name || undefined, email };
      }
      const email = sanitizeHeaderText(part.replace(/^[<\s]+|[>\s]+$/g, "")).replace(
        /[\s<>]/g,
        "",
      );
      if (!email.includes("@")) return null;
      return { email };
    })
    .filter((item): item is EmailAddress => Boolean(item));
}

export function decodeQuotedPrintable(input: string, headerMode = false): string {
  const normalized = headerMode ? input.replace(/_/g, " ") : input.replace(/=\r?\n/g, "");
  const bytes: number[] = [];
  for (let i = 0; i < normalized.length; i += 1) {
    const char = normalized[i];
    if (char === "=" && /^[0-9a-fA-F]{2}$/.test(normalized.slice(i + 1, i + 3))) {
      bytes.push(Number.parseInt(normalized.slice(i + 1, i + 3), 16));
      i += 2;
      continue;
    }
    for (const byte of Buffer.from(char, "utf8")) bytes.push(byte);
  }
  return Buffer.from(bytes).toString("utf8");
}

export function decodeTransferEncoding(value: string, encoding: string | undefined): string {
  const normalized = (encoding ?? "").trim().toLowerCase();
  if (normalized === "base64") {
    try {
      return Buffer.from(value.replace(/\s+/g, ""), "base64").toString("utf8");
    } catch {
      return value;
    }
  }
  if (normalized === "quoted-printable") return decodeQuotedPrintable(value);
  return value;
}

export function stripHtml(value: string): string {
  return value
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(?:p|div|tr|li|h[1-6])>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function summarizeText(value: string, limit = 240): string {
  const compact = value.replace(/\s+/g, " ").trim();
  return compact.length > limit ? `${compact.slice(0, limit)}...` : compact;
}
