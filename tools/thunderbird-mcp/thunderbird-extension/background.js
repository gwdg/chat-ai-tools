const POLL_MS = 250;
const HEARTBEAT_MS = 1000;
const SOCKET_WORKERS = 4;
const SOCKET_RETRY_MS = 5000;
const MAX_ACTIVE_COMMANDS = 6;
let announced = false;
let socketWorkersStarted = false;
let activeCommands = 0;
const commandQueue = [];

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function errorText(error) {
  return error && error.message ? error.message : String(error);
}

function pumpCommandQueue() {
  while (activeCommands < MAX_ACTIVE_COMMANDS && commandQueue.length) {
    const item = commandQueue.shift();
    activeCommands += 1;
    Promise.resolve()
      .then(() => handleCommand(item.command))
      .then((result) => item.respond({ ok: true, result }))
      .catch((error) => item.respond({ ok: false, error: errorText(error) }))
      .finally(() => {
        activeCommands -= 1;
        pumpCommandQueue();
      });
  }
}

function enqueueCommand(item) {
  commandQueue.push(item);
  pumpCommandQueue();
}

function mapFolder(folder, account) {
  return {
    id: folder.id,
    name: folder.name,
    path: folder.path,
    specialUse: folder.specialUse || [],
    accountId: folder.accountId || account?.id,
    accountName: account?.name,
    accountType: account?.type,
    isRoot: Boolean(folder.isRoot),
    isVirtual: Boolean(folder.isVirtual),
  };
}

function mapIdentity(identity) {
  return {
    id: identity.id,
    email: identity.email,
    name: identity.name,
    label: identity.label,
  };
}

function mapMessage(message) {
  return {
    id: message.id,
    headerMessageId: message.headerMessageId,
    subject: message.subject,
    author: message.author,
    recipients: message.recipients,
    ccList: message.ccList,
    bccList: message.bccList,
    date: message.date,
    read: message.read,
    flagged: message.flagged,
    junk: message.junk,
    priority: message.priority,
    size: message.size,
    folder: message.folder
      ? {
          id: message.folder.id,
          name: message.folder.name,
          path: message.folder.path,
          accountId: message.folder.accountId,
        }
      : undefined,
  };
}

function dateBound(value, endOfDay) {
  if (!value) return undefined;
  const raw = String(value).trim();
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) return undefined;
  if (endOfDay && /^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    date.setUTCHours(23, 59, 59, 999);
  }
  return date;
}

function stripHtmlForPreview(value) {
  return String(value || "")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|tr|h[1-6])>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)));
}

function partText(part) {
  if (!part || typeof part !== "object") return "";
  const contentType = String(part.contentType || "").toLowerCase();
  if (contentType.startsWith("text/plain")) return String(part.body || "");
  if (contentType.startsWith("text/html")) {
    return stripHtmlForPreview(String(part.body || ""));
  }
  for (const child of part.parts || []) {
    const text = partText(child);
    if (text.trim()) return text;
  }
  return "";
}

function cleanPreviewText(value) {
  return String(value || "")
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function firstPreviewLines(value, maxLines) {
  const normalized = cleanPreviewText(value);
  if (!normalized) return undefined;
  const lines = normalized
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const preview = lines.slice(0, maxLines).join("\n").slice(0, 600).trim();
  return preview || undefined;
}

function salutationFromText(value) {
  const normalized = cleanPreviewText(value);
  if (!normalized) return undefined;
  const lines = normalized
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  for (const line of lines.slice(0, 8)) {
    if (/^(von|from|an|to|cc|bcc|betreff|subject|gesendet|sent|datum|date):/i.test(line)) {
      continue;
    }
    if (/^>/.test(line)) continue;
    if (/^[-–—]{2,}/.test(line)) continue;
    if (line.length > 140) continue;
    return line;
  }
  return undefined;
}

function rawPreviewText(raw) {
  const split = String(raw || "").split(/\r?\n\r?\n/);
  if (split.length < 2) return "";
  const header = split[0].toLowerCase();
  if (header.includes("content-type: multipart/")) return "";
  const body = split.slice(1).join("\n\n");
  return header.includes("content-type: text/html")
    ? stripHtmlForPreview(body)
    : body;
}

async function previewForMessage(messageId, maxLines) {
  const numericId = Number(messageId);
  if (!Number.isFinite(numericId)) {
    throw new Error(`Invalid message id: ${messageId}`);
  }
  const header = await browser.messages.get(numericId);
  if (!header || !header.folder) {
    throw new Error("Message is not accessible.");
  }
  let text = "";
  try {
    const full = await browser.messages.getFull(numericId);
    text = partText(full);
  } catch {
    const file = await browser.messages.getRaw(numericId, { data_format: "File" });
    text = rawPreviewText(await file.text());
  }
  return {
    id: String(messageId),
    preview: firstPreviewLines(text, maxLines),
    salutation: salutationFromText(text),
  };
}

async function previewMessages(command) {
  const ids = Array.isArray(command.messageIds)
    ? command.messageIds.map(String).filter(Boolean)
    : [];
  const maxLines = Math.max(1, Math.min(20, Number(command.maxLines) || 6));
  const previews = [];
  let next = 0;
  const workerCount = Math.min(4, ids.length);
  async function worker() {
    while (next < ids.length) {
      const id = ids[next];
      next += 1;
      try {
        previews.push(await previewForMessage(id, maxLines));
      } catch (error) {
        previews.push({ id, error: errorText(error) });
      }
    }
  }
  await Promise.all(Array.from({ length: workerCount }, worker));
  return { previews };
}

async function collectMessages(queryInfo, max) {
  const pageSize = Math.min(1000, Math.max(100, max || 100));
  let list = await browser.messages.query({
    ...queryInfo,
    messagesPerPage: pageSize,
  });
  const messages = [...list.messages];
  while (list.id && messages.length < max) {
    list = await browser.messages.continueList(list.id);
    messages.push(...list.messages);
  }
  return messages;
}

async function collectListedMessages(folderId, max) {
  let list = await browser.messages.list(folderId, {
    sortType: "date",
    sortOrder: "descending",
  });
  const messages = [...list.messages];
  while (list.id && messages.length < max) {
    list = await browser.messages.continueList(list.id);
    messages.push(...list.messages);
  }
  return messages;
}

async function resolveMessageId(command) {
  if (command.messageId !== undefined && command.messageId !== null) {
    const raw = String(command.messageId);
    return /^\d+$/.test(raw) ? Number(raw) : raw;
  }
  if (!command.headerMessageId) throw new Error("messageId or headerMessageId is required");
  const messages = await collectMessages(
    { headerMessageId: String(command.headerMessageId).replace(/^<|>$/g, "") },
    5,
  );
  if (!messages.length) throw new Error(`Message not found: ${command.headerMessageId}`);
  return messages[0].id;
}

function flattenFolders(folder, result = []) {
  if (!folder) return result;
  result.push(folder);
  for (const child of folder.subFolders || []) flattenFolders(child, result);
  return result;
}

async function listAccounts() {
  const accounts = await browser.accounts.list(true);
  return {
    accounts: accounts.map((account) => ({
      id: account.id,
      name: account.name,
      type: account.type,
      identities: (account.identities || []).map(mapIdentity),
      folders: flattenFolders(account.rootFolder).map((folder) =>
        mapFolder(folder, account),
      ),
    })),
  };
}

async function listFolders(command) {
  const accounts = await browser.accounts.list(true);
  const withCounts = command.counts !== false;
  const folders = [];
  for (const account of accounts) {
    for (const folder of flattenFolders(account.rootFolder)) {
      let info = {};
      if (withCounts) {
        try {
          info = await browser.folders.getFolderInfo(folder.id);
        } catch {
          info = {};
        }
      }
      folders.push({
        ...mapFolder(folder, account),
        totalMessageCount: info.totalMessageCount,
        unreadMessageCount: info.unreadMessageCount,
        newMessageCount: info.newMessageCount,
        lastUsed: info.lastUsed,
      });
    }
  }
  return { folders };
}

async function listMessages(command) {
  const accounts = await browser.accounts.list(true);
  const wantedPath = String(command.folderPath || "").toLowerCase();
  const wantedAccount = String(command.accountLabel || "").toLowerCase();
  let folder;
  if (command.folderId) {
    folder = await browser.folders.get(String(command.folderId));
  } else {
    for (const account of accounts) {
      const names = [
        account.name,
        account.id,
        ...(account.identities || []).map((identity) => identity.email),
      ]
        .filter(Boolean)
        .map((value) => String(value).toLowerCase());
      if (
        wantedAccount &&
        !names.some((name) => name === wantedAccount || name.includes(wantedAccount))
      ) {
        continue;
      }
      folder = flattenFolders(account.rootFolder).find(
        (candidate) => String(candidate.path || "").toLowerCase() === wantedPath,
      );
      if (folder) break;
    }
  }
  if (!folder) {
    throw new Error(
      command.folderId
        ? `Folder not found: ${command.folderId}`
        : `Folder not found: ${command.folderPath}`,
    );
  }
  const offset = Number(command.offset) || 0;
  const limit = Math.max(1, Number(command.limit) || 5000);
  const fromDate = dateBound(command.fromDate, false);
  const toDate = dateBound(command.toDate, true);
  if (command.fromDate && !fromDate) throw new Error("Invalid fromDate");
  if (command.toDate && !toDate) throw new Error("Invalid toDate");
  const dateFiltered = Boolean(fromDate || toDate);
  let messages;
  if (command.unreadOnly || dateFiltered) {
    messages = await collectMessages(
      {
        folderId: folder.id,
        ...(command.unreadOnly ? { unread: true } : {}),
        ...(fromDate ? { fromDate } : {}),
        ...(toDate ? { toDate } : {}),
      },
      offset + limit,
    );
    messages.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
  } else {
    try {
      messages = await collectListedMessages(folder.id, offset + limit);
    } catch {
      messages = await collectMessages({ folderId: folder.id }, offset + limit);
      messages.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
    }
  }
  let info = {};
  try {
    info = await browser.folders.getFolderInfo(folder.id);
  } catch {
    info = {};
  }
  const page = messages.slice(offset, offset + limit);
  let mapped;
  if (command.includePreview) {
    const maxLines = Math.max(1, Math.min(20, Number(command.maxPreviewLines) || 6));
    mapped = await Promise.all(
      page.map(async (message) => ({
        ...mapMessage(message),
        ...(await previewForMessage(message.id, maxLines).catch(() => ({}))),
      })),
    );
  } else {
    mapped = page.map(mapMessage);
  }
  return {
    folder: {
      ...mapFolder(folder),
      totalMessageCount: info.totalMessageCount,
      unreadMessageCount: info.unreadMessageCount,
      newMessageCount: info.newMessageCount,
    },
    messages: mapped,
  };
}

async function readRaw(command) {
  const messageId = await resolveMessageId(command);
  const header = await browser.messages.get(messageId);
  const file = await browser.messages.getRaw(messageId, { data_format: "File" });
  const raw = await file.text();
  return {
    messageId,
    raw,
    read: header.read,
    flagged: header.flagged,
    headerMessageId: header.headerMessageId,
  };
}

async function markMessage(command) {
  const rawId =
    command.messageId !== undefined && command.messageId !== null
      ? String(command.messageId)
      : "";
  const folderId = command.folderId ? String(command.folderId) : "";

  if (/^\d+$/.test(rawId) && folderId) {
    const message = await browser.messages.get(Number(rawId));
    if (!message.folder || message.folder.id !== folderId) {
      throw new Error("Refusing to mark: message is not in the expected folder.");
    }
  }

  let headerMessageId = command.headerMessageId;
  if (!headerMessageId && rawId) {
    if (!/^\d+$/.test(rawId)) {
      headerMessageId = rawId;
    } else {
      const message = await browser.messages.get(Number(rawId));
      if (!message.folder) {
        throw new Error("Refusing to mark: message not found.");
      }
      headerMessageId = message.headerMessageId;
    }
  }
  if (!headerMessageId) throw new Error("messageId or headerMessageId is required");
  return browser.mcpFlags.markMessage(
    String(headerMessageId).replace(/^<|>$/g, ""),
    command.read,
    command.answered,
    command.accountKey,
    command.priority,
  );
}

async function searchMessages(command) {
  const max = Math.max(1, Number(command.limit) || 50) + (Number(command.offset) || 0);
  const queryInfo = {};
  if (command.query) queryInfo.fullText = String(command.query);
  if (command.author) queryInfo.author = String(command.author);
  if (command.recipients) queryInfo.recipients = String(command.recipients);
  if (command.subject) queryInfo.subject = String(command.subject);
  if (command.body) queryInfo.body = String(command.body);
  if (Array.isArray(command.folderIds) && command.folderIds.length) {
    const visible = [];
    for (const folderId of command.folderIds.map(String)) {
      try {
        const folder = await browser.folders.get(folderId);
        if (folder) visible.push(folderId);
      } catch {
        // Ignore folders that disappeared.
      }
    }
    queryInfo.folderId = visible;
  } else if (command.folderId) {
    const folderId = String(command.folderId);
    const folder = await browser.folders.get(folderId);
    if (!folder) {
      throw new Error(`Folder not found: ${folderId}`);
    }
    queryInfo.folderId = folderId;
  }
  if (command.unreadOnly) queryInfo.unread = true;
  if (typeof command.flagged === "boolean") queryInfo.flagged = command.flagged;
  if (typeof command.hasAttachment === "boolean") {
    queryInfo.attachment = command.hasAttachment;
  }
  if (command.fromDate) {
    const date = new Date(String(command.fromDate));
    if (!Number.isNaN(date.getTime())) queryInfo.fromDate = date;
  }
  if (command.toDate) {
    const date = new Date(String(command.toDate));
    if (!Number.isNaN(date.getTime())) queryInfo.toDate = date;
  }
  if (command.tags && typeof command.tags === "object") {
    const tags = { tags: {}, mode: "any" };
    for (const [key, value] of Object.entries(command.tags)) {
      if (typeof value === "boolean") tags.tags[key] = value;
    }
    if (command.tagMode === "all" || command.tagMode === "none" || command.tagMode === "any") {
      tags.mode = command.tagMode;
    }
    if (Object.keys(tags.tags).length) queryInfo.tags = tags;
  }
  if (command.sizeMin !== undefined || command.sizeMax !== undefined) {
    queryInfo.size = {
      ...(command.sizeMin !== undefined ? { min: Number(command.sizeMin) } : {}),
      ...(command.sizeMax !== undefined ? { max: Number(command.sizeMax) } : {}),
    };
  }
  const messages = await collectMessages(queryInfo, max);
  messages.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
  return {
    messages: messages.slice(Number(command.offset) || 0, max).map(mapMessage),
  };
}

function attachmentFiles(attachments) {
  if (!Array.isArray(attachments)) return [];
  return attachments.map((attachment) => {
    const binary = atob(attachment.contentBase64 || "");
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return {
      file: new File([bytes], attachment.filename, {
        type: attachment.contentType || "application/octet-stream",
      }),
      name: attachment.filename,
    };
  });
}

async function saveDraft(command) {
  const identities = await browser.identities.list();
  const wanted = String(command.identityEmail || "").toLowerCase();
  const identity =
    identities.find((item) => String(item.email || "").toLowerCase() === wanted) ||
    identities[0];
  if (!identity) throw new Error("No Thunderbird identity is configured");

  const details = {
    identityId: identity.id,
    to: command.to || [],
    cc: command.cc || [],
    bcc: command.bcc || [],
    subject: command.subject || "",
    isPlainText: !command.html,
  };
  if (command.html) details.body = command.html;
  else details.plainTextBody = command.text || "";

  const headers = [];
  if (command.inReplyTo) {
    headers.push({ name: "In-Reply-To", value: command.inReplyTo });
  }
  if (Array.isArray(command.references) && command.references.length) {
    headers.push({ name: "References", value: command.references.join(" ") });
  }
  if (headers.length) details.customHeaders = headers;

  const attachments = attachmentFiles(command.attachments);
  if (attachments.length) details.attachments = attachments;

  const result = await browser.messages.saveMessage(details, { mode: "draft" });
  return { mode: result.mode, messages: (result.messages || []).map(mapMessage) };
}

async function handleCommand(command) {
  switch (command.command) {
    case "mark":
      return markMessage(command);
    case "accounts":
      return listAccounts();
    case "folders":
      return listFolders(command);
    case "list":
      return listMessages(command);
    case "preview":
      return previewMessages(command);
    case "read":
      return readRaw(command);
    case "search":
      return searchMessages(command);
    case "saveDraft":
      return saveDraft(command);
    case "capabilities": {
      return { version: browser.runtime.getManifest().version };
    }
    case "diagnose": {
      const socketStatus = browser.mcpFlags.socketStatus
        ? JSON.parse(await browser.mcpFlags.socketStatus())
        : null;
      return {
        time: Date.now(),
        version: browser.runtime.getManifest().version,
        ping: await browser.mcpFlags.ping(),
        socket: socketStatus,
        heartbeat: await browser.mcpFlags.touchStatus(),
      };
    }
    default:
      throw new Error(`Unknown command: ${command.command}`);
  }
}

async function heartbeat() {
  try {
    const status = await browser.mcpFlags.touchStatus();
    if (!status.ok) {
      console.error("[thunderbird-mcp] touchStatus failed:", status.error);
    }
  } catch (error) {
    console.error("[thunderbird-mcp] heartbeat failed:", errorText(error));
  }
}

async function announce() {
  try {
    const ping = await browser.mcpFlags.ping();
    if (!ping.ok) {
      console.error("[thunderbird-mcp] ping failed:", ping.error);
      return;
    }
    if (!announced) {
      announced = true;
      console.log(
        `[thunderbird-mcp] bridge profile: ${ping.profile}; modules=${JSON.stringify(
          ping.modules,
        )}`,
      );
    }
  } catch (error) {
    console.error("[thunderbird-mcp] ping failed:", errorText(error));
  }
}

async function pollFileCommands() {
  try {
    const pending = await browser.mcpFlags.takeCommands();
    if (!pending.ok) {
      console.error("[thunderbird-mcp] takeCommands failed:", pending.error);
      return;
    }
    for (const command of pending.commands || []) {
      const id = command && command.id;
      enqueueCommand({
        command,
        respond: (payload) => {
          payload.id = id;
          return browser.mcpFlags
            .writeResult(JSON.stringify(payload))
            .then((written) => {
              if (!written.ok) {
                console.error("[thunderbird-mcp] writeResult failed:", written.error);
              }
            });
        },
      });
    }
  } catch (error) {
    console.error("[thunderbird-mcp] file poll failed:", errorText(error));
  } finally {
    setTimeout(pollFileCommands, POLL_MS);
  }
}

async function socketWorker() {
  for (;;) {
    let item = null;
    try {
      const raw = await browser.mcpFlags.takeRequest();
      item = raw && raw !== "null" ? JSON.parse(raw) : null;
    } catch (error) {
      console.error("[thunderbird-mcp] takeRequest failed:", errorText(error));
    }
    if (!item || !item.request) {
      await delay(100);
      continue;
    }
    const { connectionId, request } = item;
    enqueueCommand({
      command: request,
      respond: (payload) => {
        payload.id = request.id;
        return browser.mcpFlags
          .sendResponse(connectionId, JSON.stringify(payload))
          .then((written) => {
            if (written && !written.ok) {
              console.error("[thunderbird-mcp] sendResponse failed:", written.error);
            }
          });
      },
    });
  }
}

function startSocketWorkers() {
  if (socketWorkersStarted) return;
  socketWorkersStarted = true;
  for (let index = 0; index < SOCKET_WORKERS; index += 1) socketWorker();
}

async function startSocketBridge() {
  if (!browser.mcpFlags.socketStart) {
    console.warn("[thunderbird-mcp] socket bridge API is unavailable");
    return;
  }
  try {
    const result = JSON.parse(await browser.mcpFlags.socketStart());
    if (result.ok) {
      console.log(`[thunderbird-mcp] socket bridge: ${result.path}`);
      startSocketWorkers();
      return;
    }
    if (result.disabled) {
      console.info("[thunderbird-mcp] socket bridge disabled:", result.error);
      return;
    }
    console.error("[thunderbird-mcp] socketStart failed:", result.error);
  } catch (error) {
    console.error("[thunderbird-mcp] socketStart failed:", errorText(error));
  }
  setTimeout(startSocketBridge, SOCKET_RETRY_MS);
}

setInterval(heartbeat, HEARTBEAT_MS);
heartbeat();
announce();
pollFileCommands();
startSocketBridge();
