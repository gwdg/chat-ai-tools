import { simpleParser } from "mailparser";

import { decodeWords, formatAddressList, stripHtml } from "./encoding.js";
import { readRawFromExtension } from "./extension-bridge.js";
import type { EmailAddress } from "./types.js";

export interface QuotedReply {
  text: string;
  html?: string;
  included: boolean;
  warning?: string;
}

interface OriginalMessage {
  subject: string;
  text: string;
  html?: string;
  from: EmailAddress[];
  date?: string;
  dateRaw?: string;
}

function normalizeMessageId(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const normalized = value.trim().replace(/\s+/g, "").replace(/^<|>$/g, "");
  return normalized || undefined;
}

async function readOriginal(
  profileRoot: string,
  messageId: string,
): Promise<OriginalMessage | null> {
  try {
    const raw = await readRawFromExtension(profileRoot, undefined, messageId);
    const parsed = await simpleParser(raw.raw);
    const from = (parsed.from?.value ?? [])
      .filter((item) => item.address)
      .map((item) => ({ name: item.name || undefined, email: item.address as string }));
    return {
      subject: decodeWords(parsed.subject ?? ""),
      text: parsed.text ?? "",
      html: typeof parsed.html === "string" ? parsed.html : undefined,
      from,
      date: parsed.date?.toISOString(),
      dateRaw: parsed.headers.get("date")?.toString(),
    };
  } catch {
    return null;
  }
}

function isGermanLike(value: string): boolean {
  if (/[äöüß]/i.test(value)) return true;
  return /\b(der|die|das|und|nicht|vielen|dank|grüße|sehr|geehrte|liebe|lieber|hallo|freundlichen)\b/i.test(
    value,
  );
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

function formatDate(date: Date, german: boolean): string {
  if (german) {
    return `${pad(date.getUTCDate())}.${pad(date.getUTCMonth() + 1)}.${date.getUTCFullYear()} um ${pad(
      date.getUTCHours(),
    )}:${pad(date.getUTCMinutes())}`;
  }
  const months = [
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec",
  ];
  return `${date.getUTCDate()} ${months[date.getUTCMonth()]} ${date.getUTCFullYear()} at ${pad(
    date.getUTCHours(),
  )}:${pad(date.getUTCMinutes())}`;
}

function senderLocalDate(original: OriginalMessage): Date | null {
  if (!original.date) return null;
  const date = new Date(original.date);
  if (Number.isNaN(date.getTime())) return null;

  const offset = /([+-])(\d{2})(\d{2})\s*$/.exec(original.dateRaw ?? "");
  if (!offset) return date;
  const sign = offset[1] === "-" ? -1 : 1;
  const minutes = sign * (Number(offset[2]) * 60 + Number(offset[3]));
  return new Date(date.getTime() + minutes * 60000);
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function quoteBlock(original: OriginalMessage): { text: string; html: string } {
  const body = (
    original.text.trim() || (original.html ? stripHtml(original.html).trim() : "")
  ).trim();
  const sample = `${original.subject} ${body}`.slice(0, 2000);
  const german = isGermanLike(sample);
  const sender = formatAddressList(original.from) || original.from[0]?.email || "Unknown";
  const date = senderLocalDate(original);
  const header = date
    ? german
      ? `Am ${formatDate(date, true)} schrieb ${sender}:`
      : `On ${formatDate(date, false)}, ${sender} wrote:`
    : german
      ? `${sender} schrieb:`
      : `${sender} wrote:`;

  const quotedBody = body
    .split(/\r?\n/)
    .map((line) => (line.trim() ? `> ${line}` : ">"))
    .join("\n");
  const text = quotedBody ? `${header}\n${quotedBody}` : header;
  const html = `<blockquote>\n${(quotedBody || header)
    .split("\n")
    .map((line) => `<p>${escapeHtml(line) || "&nbsp;"}</p>`)
    .join("\n")}\n</blockquote>`;
  return { text, html };
}

function alreadyQuoted(
  replyText: string,
  replyHtml: string | undefined,
  original: OriginalMessage,
): boolean {
  const hasQuote =
    /(^|\n)>\s?/.test(replyText) || /<blockquote[\s>]/i.test(replyHtml ?? "");
  if (!hasQuote) return false;
  const firstLine = (original.text || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);
  if (!firstLine) return true;
  return (
    replyText.includes(firstLine) ||
    (replyHtml ?? "").toLowerCase().includes(escapeHtml(firstLine).toLowerCase())
  );
}

export async function buildQuotedReply(
  profileRoot: string,
  inReplyTo: string,
  replyText: string,
  replyHtml?: string,
): Promise<QuotedReply> {
  const messageId = normalizeMessageId(inReplyTo);
  if (!messageId) {
    return {
      text: replyText,
      html: replyHtml,
      included: false,
      warning: "Invalid In-Reply-To message id.",
    };
  }

  const original = await readOriginal(profileRoot, messageId);
  if (!original) {
    return {
      text: replyText,
      html: replyHtml,
      included: false,
      warning: "Could not locate the original message to quote it.",
    };
  }

  if (alreadyQuoted(replyText, replyHtml, original)) {
    return { text: replyText, html: replyHtml, included: true };
  }

  const quote = quoteBlock(original);
  const text = replyText.trim()
    ? `${replyText.trimEnd()}\n\n${quote.text}`
    : `${quote.text}\n`;
  const html = replyHtml?.trim()
    ? `${replyHtml.trimEnd()}\n${quote.html}`
    : replyHtml;
  return { text, html, included: true };
}
