import { simpleParser } from "mailparser";

import {
  decodeTransferEncoding,
  decodeWords,
  parseAddressList,
  sanitizeHeaderText,
  sanitizeUntrustedText,
  stripHtml,
  summarizeText,
  unfoldHeaders,
} from "./encoding.js";
import { UserError } from "./profile.js";
import type {
  EmailAddress,
  FolderInfo,
  MessageSummary,
  ParsedMessage,
} from "./types.js";

export interface RawMessageRef {
  index: number;
  key?: string;
  fromLine: string;
  raw: string;
  offset?: number;
}

export interface PostalHeaders {
  [key: string]: string;
}

export function splitHeaderBody(raw: string): { headerBlock: string; body: string } {
  const match = /\r?\n\r?\n/.exec(raw);
  if (!match) return { headerBlock: raw, body: "" };
  return {
    headerBlock: raw.slice(0, match.index),
    body: raw.slice(match.index + match[0].length),
  };
}

export function parseHeaderMap(headerBlock: string): PostalHeaders {
  const headers: PostalHeaders = {};
  const unfolded = unfoldHeaders(headerBlock);
  for (const line of unfolded.split(/\r?\n/)) {
    const match = /^([^:\s]+):\s*(.*)$/.exec(line);
    if (!match) continue;
    const key = match[1].toLowerCase();
    const value = match[2].trim();
    headers[key] = headers[key] ? `${headers[key]}, ${value}` : value;
  }
  return headers;
}

export function parseDate(
  value: string | undefined,
): { iso: string | null; raw: string | null } {
  if (!value) return { iso: null, raw: null };
  const cleaned = value.replace(/\s*\([^)]*\)\s*$/, "").trim();
  const date = new Date(cleaned);
  return {
    iso: Number.isNaN(date.getTime()) ? null : date.toISOString(),
    raw: value,
  };
}

function safeMessageId(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const cleaned = sanitizeUntrustedText(value).replace(/[\s<>]/g, "");
  return cleaned || undefined;
}

function displayHeaders(headers: PostalHeaders): Record<string, string> {
  const keys = [
    "from",
    "to",
    "cc",
    "bcc",
    "subject",
    "date",
    "message-id",
    "in-reply-to",
    "references",
    "content-type",
    "x-mozilla-status",
  ];
  const result: Record<string, string> = {};
  for (const key of keys) result[key] = sanitizeHeaderText(headers[key] ?? "");
  return result;
}

function statusFlags(headers: PostalHeaders): {
  read: boolean;
  flagged: boolean;
  replied: boolean;
  hasAttachment: boolean;
} {
  const rawStatus = headers["x-mozilla-status"];
  const status = rawStatus ? Number.parseInt(rawStatus, 16) : 0;
  return {
    read: Boolean(status & 0x1),
    replied: Boolean(status & 0x2),
    flagged: Boolean(status & 0x4),
    hasAttachment: /multipart\/mixed/i.test(headers["content-type"] ?? ""),
  };
}

function snippetFor(headers: PostalHeaders, raw: string): string {
  const contentType = (headers["content-type"] ?? "").toLowerCase();
  if (contentType.startsWith("multipart/")) return "";
  const { body } = splitHeaderBody(raw);
  if (!body.trim()) return "";
  try {
    const decoded = decodeTransferEncoding(body, headers["content-transfer-encoding"]);
    const text = contentType.includes("text/html") ? stripHtml(decoded) : decoded;
    return summarizeText(sanitizeUntrustedText(text));
  } catch {
    return "";
  }
}

export function snippetForRaw(raw: string): string | undefined {
  const { headerBlock } = splitHeaderBody(raw);
  const headers = parseHeaderMap(headerBlock);
  return snippetFor(headers, raw) || undefined;
}

function normalizeAddressObject(value: unknown): EmailAddress[] {
  if (!value) return [];
  const list = Array.isArray(value) ? value : [value];
  const addresses: EmailAddress[] = [];
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const object = item as { value?: Array<{ name?: string; address?: string }> };
    if (!Array.isArray(object.value)) continue;
    for (const entry of object.value) {
      if (!entry?.address) continue;
      const email = sanitizeUntrustedText(entry.address).replace(/[\s<>]/g, "");
      if (!email) continue;
      addresses.push({
        name: entry.name ? sanitizeHeaderText(entry.name) : undefined,
        email,
      });
    }
  }
  return addresses;
}

function normalizeReferences(value: unknown): string[] {
  if (!value) return [];
  const raw = Array.isArray(value) ? value.map(String) : [String(value)];
  return raw
    .flatMap((item) => item.match(/<[^<>]+>|\S+/g) ?? [])
    .map((item) => safeMessageId(item))
    .filter((item): item is string => Boolean(item));
}

export async function parseFullMessage(
  folder: FolderInfo,
  ref: RawMessageRef,
  includeHtml: boolean,
): Promise<ParsedMessage> {
  const { headerBlock, body } = splitHeaderBody(ref.raw);
  const headers = parseHeaderMap(headerBlock);
  const flags = statusFlags(headers);
  const fallbackDate = parseDate(headers.date);

  try {
    const parsed = await simpleParser(ref.raw);
    const date = parsed.date
      ? { iso: parsed.date.toISOString(), raw: headers.date ?? null }
      : fallbackDate;
    const parsedMessageId = safeMessageId(parsed.messageId);
    return {
      id: encodeMessageId(
        folder.id,
        ref.index,
        ref.key,
        ref.offset,
        parsedMessageId,
      ),
      folder: folder.id,
      folderName: sanitizeHeaderText(`${folder.accountLabel}/${folder.path}`),
      index: ref.index,
      subject: sanitizeHeaderText(parsed.subject || decodeWords(headers.subject ?? "")),
      from: normalizeAddressObject(parsed.from),
      to: normalizeAddressObject(parsed.to),
      cc: normalizeAddressObject(parsed.cc),
      bcc: normalizeAddressObject(parsed.bcc),
      replyTo: normalizeAddressObject(parsed.replyTo),
      date: date.iso,
      dateRaw: date.raw ? sanitizeHeaderText(date.raw) : null,
      messageId: parsedMessageId ?? null,
      inReplyTo: parsed.inReplyTo ? sanitizeHeaderText(parsed.inReplyTo) : null,
      references: normalizeReferences(parsed.references),
      text: sanitizeUntrustedText(parsed.text ?? ""),
      html:
        includeHtml && typeof parsed.html === "string"
          ? sanitizeUntrustedText(parsed.html)
          : undefined,
      attachments: (parsed.attachments ?? []).map((attachment) => ({
        filename: sanitizeHeaderText(attachment.filename || "(unnamed)"),
        contentType: sanitizeHeaderText(
          attachment.contentType || "application/octet-stream",
        ),
        size: attachment.size ?? 0,
      })),
      read: flags.read,
      flagged: flags.flagged,
      replied: flags.replied,
      headers: displayHeaders(headers),
    };
  } catch {
    const text = decodeTransferEncoding(body, headers["content-transfer-encoding"]);
    const isHtml = /text\/html/i.test(headers["content-type"] ?? "");
    const parsedMessageId = safeMessageId(headers["message-id"]);
    return {
      id: encodeMessageId(
        folder.id,
        ref.index,
        ref.key,
        ref.offset,
        parsedMessageId,
      ),
      folder: folder.id,
      folderName: sanitizeHeaderText(`${folder.accountLabel}/${folder.path}`),
      index: ref.index,
      subject: decodeWords(headers.subject ?? ""),
      from: parseAddressList(headers.from),
      to: parseAddressList(headers.to),
      cc: parseAddressList(headers.cc),
      bcc: parseAddressList(headers.bcc),
      replyTo: parseAddressList(headers["reply-to"]),
      date: fallbackDate.iso,
      dateRaw: fallbackDate.raw ? sanitizeHeaderText(fallbackDate.raw) : null,
      messageId: parsedMessageId ?? null,
      inReplyTo: safeMessageId(headers["in-reply-to"]) ?? null,
      references: normalizeReferences(headers.references),
      text: sanitizeUntrustedText(isHtml ? stripHtml(text) : text),
      html: includeHtml && isHtml ? sanitizeUntrustedText(text) : undefined,
      attachments: [],
      read: flags.read,
      flagged: flags.flagged,
      replied: flags.replied,
      headers: displayHeaders(headers),
    };
  }
}

export function encodeMessageId(
  folderId: string,
  index: number,
  key?: string,
  offset?: number,
  messageId?: string,
  extensionId?: string,
): string {
  const payload: Record<string, unknown> = { f: folderId, i: index };
  if (key) payload.k = key;
  if (offset !== undefined) payload.o = offset;
  const safeId = safeMessageId(messageId);
  if (safeId) payload.m = safeId;
  if (extensionId) payload.x = String(extensionId);
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

export function decodeMessageId(id: string): {
  folderId: string;
  index: number;
  key?: string;
  offset?: number;
  messageId?: string;
  extensionId?: string;
} {
  try {
    const parsed = JSON.parse(Buffer.from(id, "base64url").toString("utf8")) as {
      f?: unknown;
      i?: unknown;
      k?: unknown;
      o?: unknown;
      m?: unknown;
      x?: unknown;
    };
    if (typeof parsed.f !== "string" || typeof parsed.i !== "number") {
      throw new Error("invalid payload");
    }
    const decoded: {
      folderId: string;
      index: number;
      key?: string;
      offset?: number;
      messageId?: string;
      extensionId?: string;
    } = { folderId: parsed.f, index: parsed.i };
    if (typeof parsed.k === "string") decoded.key = parsed.k;
    if (typeof parsed.o === "number") decoded.offset = parsed.o;
    if (typeof parsed.m === "string") decoded.messageId = parsed.m;
    if (typeof parsed.x === "string") decoded.extensionId = parsed.x;
    return decoded;
  } catch {
    throw new UserError("Invalid message id. Use an id returned by list_emails or search_emails.");
  }
}
