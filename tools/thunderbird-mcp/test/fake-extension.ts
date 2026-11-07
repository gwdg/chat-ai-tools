import {
  mkdirSync,
  readFileSync,
  readdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

export interface FakeFolder {
  id: string;
  name: string;
  path: string;
  specialUse: string[];
  accountId: string;
  accountName: string;
  totalMessageCount?: number;
  unreadMessageCount?: number;
  newMessageCount?: number;
}

export interface FakeMessage {
  id: string;
  headerMessageId: string;
  subject: string;
  author: string;
  recipients: string[];
  ccList?: string[];
  date: string;
  read: boolean;
  flagged: boolean;
  priority?: string;
  folderId: string;
  raw: string;
}

export interface FakeAccount {
  id: string;
  name: string;
  type: string;
  identities: Array<{ id: string; email: string; name?: string }>;
}

export interface FakeExtensionState {
  accounts: FakeAccount[];
  folders: FakeFolder[];
  messages: FakeMessage[];
  savedDrafts: Array<Record<string, unknown>>;
  marked: Array<Record<string, unknown>>;
}

export interface FakeExtension {
  state: FakeExtensionState;
  stop: () => void;
}

function folderFor(state: FakeExtensionState, folderId: string): FakeFolder | undefined {
  return state.folders.find((folder) => folder.id === folderId);
}

function asExtensionMessage(state: FakeExtensionState, message: FakeMessage) {
  const folder = folderFor(state, message.folderId);
  return {
    id: message.id,
    headerMessageId: message.headerMessageId,
    subject: message.subject,
    author: message.author,
    recipients: message.recipients,
    ccList: message.ccList ?? [],
    bccList: [],
    date: message.date,
    read: message.read,
    flagged: message.flagged,
    priority: message.priority ?? "none",
    junk: false,
    size: message.raw.length,
    folder: folder
      ? {
          id: folder.id,
          name: folder.name,
          path: folder.path,
          accountId: folder.accountId,
        }
      : undefined,
  };
}

function compareDate(left: FakeMessage, right: FakeMessage): number {
  return Date.parse(right.date) - Date.parse(left.date);
}

function messageBody(message: FakeMessage): string {
  const index = message.raw.indexOf("\n\n");
  return index >= 0 ? message.raw.slice(index + 2) : message.raw;
}

function previewFor(message: FakeMessage): { preview: string; salutation?: string } {
  const body = messageBody(message).replace(/\r\n?/g, "\n").trim();
  const lines = body
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  return {
    preview: lines.slice(0, 6).join("\n").slice(0, 600),
    salutation: lines[0],
  };
}

function handle(state: FakeExtensionState, command: Record<string, unknown>): unknown {
  switch (command.command) {
    case "capabilities":
      return { version: "test" };
    case "accounts":
      return {
        accounts: state.accounts.map((account) => ({
          ...account,
          folders: state.folders.filter((folder) => folder.accountId === account.id),
        })),
      };
    case "folders":
      return {
        folders: state.folders.map((folder) => ({
          ...folder,
          totalMessageCount:
            folder.totalMessageCount ??
            state.messages.filter((message) => message.folderId === folder.id).length,
          unreadMessageCount:
            folder.unreadMessageCount ??
            state.messages.filter(
              (message) => message.folderId === folder.id && !message.read,
            ).length,
        })),
      };
    case "list": {
      const folderId = String(command.folderId ?? "");
      const unreadOnly = Boolean(command.unreadOnly);
      const offset = Number(command.offset) || 0;
      const limit = Math.max(1, Number(command.limit) || 5000);
      const fromTime = command.fromDate ? Date.parse(String(command.fromDate)) : undefined;
      let toTime = command.toDate ? Date.parse(String(command.toDate)) : undefined;
      if (
        toTime !== undefined &&
        /^\d{4}-\d{2}-\d{2}$/.test(String(command.toDate))
      ) {
        toTime += 24 * 60 * 60 * 1000 - 1;
      }
      const folder = folderFor(state, folderId);
      const inFolder = state.messages.filter((message) => message.folderId === folderId);
      const selected = inFolder
        .filter((message) => !unreadOnly || !message.read)
        .filter((message) => {
          const time = Date.parse(message.date);
          if (fromTime !== undefined && time < fromTime) return false;
          if (toTime !== undefined && time > toTime) return false;
          return true;
        })
        .sort(compareDate);
      const page = selected.slice(offset, offset + limit);
      const messages = page.map((message) => ({
        ...asExtensionMessage(state, message),
        ...(command.includePreview ? previewFor(message) : {}),
      }));
      return {
        folder: folder
          ? {
              ...folder,
              totalMessageCount: inFolder.length,
              unreadMessageCount: inFolder.filter((message) => !message.read).length,
            }
          : undefined,
        messages,
      };
    }
    case "read": {
      const extensionId = String(command.messageId ?? "");
      const headerId = String(command.headerMessageId ?? "").replace(/^<|>$/g, "");
      const message = state.messages.find(
        (candidate) =>
          (extensionId && candidate.id === extensionId) ||
          (headerId && candidate.headerMessageId === headerId),
      );
      if (!message) throw new Error("Message not found");
      return {
        messageId: message.id,
        raw: message.raw,
        read: message.read,
        flagged: message.flagged,
        headerMessageId: message.headerMessageId,
      };
    }
    case "preview": {
      const ids = Array.isArray(command.messageIds)
        ? command.messageIds.map(String)
        : [];
      return {
        previews: ids.map((id) => {
          const message = state.messages.find((candidate) => candidate.id === id);
          if (!message) return { id, error: "Message not found" };
          return { id, ...previewFor(message) };
        }),
      };
    }
    case "search": {
      const query = String(command.query ?? "").toLowerCase();
      const tokens = query.split(/\s+/).filter(Boolean);
      const folderIds = Array.isArray(command.folderIds)
        ? command.folderIds.map(String)
        : command.folderId
          ? [String(command.folderId)]
          : [];
      const fromTime = command.fromDate ? Date.parse(String(command.fromDate)) : undefined;
      const toTime = command.toDate ? Date.parse(String(command.toDate)) : undefined;
      const sizeMin = command.sizeMin === undefined ? undefined : Number(command.sizeMin);
      const sizeMax = command.sizeMax === undefined ? undefined : Number(command.sizeMax);
      const selected = state.messages
        .filter((message) => !folderIds.length || folderIds.includes(message.folderId))
        .filter((message) => {
          if (command.author && !message.author.toLowerCase().includes(String(command.author).toLowerCase())) return false;
          if (command.recipients && !message.recipients.join(", ").toLowerCase().includes(String(command.recipients).toLowerCase())) return false;
          if (command.subject && !message.subject.toLowerCase().includes(String(command.subject).toLowerCase())) return false;
          if (command.body && !message.raw.toLowerCase().includes(String(command.body).toLowerCase())) return false;
          if (command.unreadOnly && message.read) return false;
          if (typeof command.flagged === "boolean" && message.flagged !== command.flagged) return false;
          if (command.hasAttachment === true) return false;
          if (fromTime !== undefined && Date.parse(message.date) < fromTime) return false;
          if (toTime !== undefined && Date.parse(message.date) > toTime) return false;
          if (sizeMin !== undefined && message.raw.length < sizeMin) return false;
          if (sizeMax !== undefined && message.raw.length > sizeMax) return false;
          const text = `${message.subject}\n${message.author}\n${message.raw}`.toLowerCase();
          return tokens.every((token) => text.includes(token));
        })
        .sort(compareDate);
      return {
        messages: selected
          .slice(
            Number(command.offset) || 0,
            (Number(command.offset) || 0) + Math.max(1, Number(command.limit) || 50),
          )
          .map((message) => asExtensionMessage(state, message)),
      };
    }
    case "mark": {
      const extensionId = String(command.messageId ?? "");
      const headerId = String(command.headerMessageId ?? "").replace(/^<|>$/g, "");
      const message = state.messages.find(
        (candidate) =>
          (extensionId && candidate.id === extensionId) ||
          (headerId && candidate.headerMessageId === headerId),
      );
      if (!message) throw new Error("Message not found");
      if (typeof command.read === "boolean") message.read = command.read;
      if (typeof command.priority === "number") {
        const names: Record<number, string> = {
          1: "none",
          2: "lowest",
          3: "low",
          4: "normal",
          5: "high",
          6: "highest",
        };
        message.priority = names[command.priority] ?? "none";
      }
      state.marked.push({ ...command });
      return {
        folder: message.folderId,
        messageKey: message.id,
        read: message.read,
        answered: Boolean(command.answered),
        priority: message.priority ?? "none",
      };
    }
    case "saveDraft": {
      const folder =
        state.folders.find((candidate) => candidate.specialUse.includes("drafts")) ??
        state.folders[0];
      const id = String(state.messages.length + 1000);
      const headerMessageId = `draft-${id}@example.com`;
      const subject = String(command.subject ?? "");
      const text = String(command.text ?? command.html ?? "");
      const message: FakeMessage = {
        id,
        headerMessageId,
        subject,
        author: String(command.identityEmail ?? "alice@example.com"),
        recipients: Array.isArray(command.to) ? command.to.map(String) : [],
        ccList: Array.isArray(command.cc) ? command.cc.map(String) : [],
        date: new Date().toISOString(),
        read: true,
        flagged: false,
        folderId: folder.id,
        raw: [
          `From: ${command.identityEmail ?? "alice@example.com"}`,
          `To: ${(Array.isArray(command.to) ? command.to : []).join(", ")}`,
          `Subject: ${subject}`,
          `Message-ID: <${headerMessageId}>`,
          `Date: ${new Date().toUTCString()}`,
          "Content-Type: text/plain; charset=UTF-8",
          "",
          text,
        ].join("\n"),
      };
      state.messages.push(message);
      state.savedDrafts.push({ ...command });
      return { mode: "draft", messages: [asExtensionMessage(state, message)] };
    }
    default:
      throw new Error(`Unknown command: ${String(command.command)}`);
  }
}

export function startFakeExtension(
  profileRoot: string,
  state: FakeExtensionState,
): FakeExtension {
  const base = path.join(profileRoot, "thunderbird-mcp-bridge");
  const commands = path.join(base, "commands");
  const results = path.join(base, "results");
  mkdirSync(commands, { recursive: true });
  mkdirSync(results, { recursive: true });

  const writeStatus = () => {
    writeFileSync(path.join(base, "status.json"), JSON.stringify({ time: Date.now() }));
  };
  writeStatus();

  const timer = setInterval(() => {
    writeStatus();
    let names: string[];
    try {
      names = readdirSync(commands);
    } catch {
      return;
    }
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      const file = path.join(commands, name);
      let command: Record<string, unknown> & { id?: string };
      try {
        command = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown> & {
          id?: string;
        };
      } catch {
        continue;
      }
      try {
        unlinkSync(file);
      } catch {
        continue;
      }
      try {
        const result = handle(state, command);
        writeFileSync(
          path.join(results, name),
          JSON.stringify({ id: command.id, ok: true, result }),
        );
      } catch (error) {
        writeFileSync(
          path.join(results, name),
          JSON.stringify({
            id: command.id,
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          }),
        );
      }
    }
  }, 20);

  return {
    state,
    stop: () => {
      clearInterval(timer);
      try {
        unlinkSync(path.join(base, "status.json"));
      } catch {
        // Ignore.
      }
    },
  };
}

export function makeFakeState(): FakeExtensionState {
  const localInbox = "folder-local-inbox";
  const localDrafts = "folder-local-drafts";
  const imapInbox = "folder-imap-inbox";
  const folders: FakeFolder[] = [
    {
      id: "folder-local-root",
      name: "Local Folders",
      path: "/",
      specialUse: [],
      accountId: "account-local",
      accountName: "Local Folders",
    },
    {
      id: localInbox,
      name: "Inbox",
      path: "Inbox",
      specialUse: ["inbox"],
      accountId: "account-local",
      accountName: "Local Folders",
    },
    {
      id: localDrafts,
      name: "Drafts",
      path: "Drafts",
      specialUse: ["drafts"],
      accountId: "account-local",
      accountName: "Local Folders",
    },
    {
      id: "folder-local-sent",
      name: "Sent",
      path: "Sent",
      specialUse: ["sent"],
      accountId: "account-local",
      accountName: "Local Folders",
    },
    {
      id: imapInbox,
      name: "INBOX",
      path: "INBOX",
      specialUse: ["inbox"],
      accountId: "account-imap",
      accountName: "imap.example.net",
    },
  ];

  const state: FakeExtensionState = {
    accounts: [
      {
        id: "account-local",
        name: "Local Folders",
        type: "local",
        identities: [
          { id: "identity-alice", email: "alice@example.com", name: "Alice Example" },
        ],
      },
      {
        id: "account-imap",
        name: "imap.example.net",
        type: "imap",
        identities: [
          { id: "identity-bob", email: "bob@example.net", name: "Bob Example" },
        ],
      },
    ],
    folders,
    messages: [],
    savedDrafts: [],
    marked: [],
  };

  const push = (message: Omit<FakeMessage, "raw"> & { body: string }) => {
    state.messages.push({
      ...message,
      raw: [
        `From: ${message.author}`,
        `To: ${message.recipients.join(", ")}`,
        `Subject: ${message.subject}`,
        `Date: ${new Date(message.date).toUTCString()}`,
        `Message-ID: <${message.headerMessageId}>`,
        "MIME-Version: 1.0",
        "Content-Type: text/plain; charset=UTF-8",
        "X-Mozilla-Status: 0000",
        "",
        message.body,
      ].join("\n"),
    });
  };

  push({
    id: "101",
    headerMessageId: "msg-1@example.com",
    subject: "Welcome to Thunderbird",
    author: "Alice Example <alice@example.com>",
    recipients: ["Bob Example <bob@example.net>"],
    date: "2024-01-01T10:00:00.000Z",
    read: false,
    flagged: false,
    folderId: localInbox,
    body: "Hello Bob,\n\nThis is the first message in the local Inbox.\n\nThanks,\nAlice",
  });
  push({
    id: "102",
    headerMessageId: "msg-2@example.de",
    subject: "Grüße aus München",
    author: "Jörg Müller <joerg@example.de>",
    recipients: ["Bob Example <bob@example.net>"],
    date: "2024-01-02T11:30:00.000Z",
    read: false,
    flagged: false,
    folderId: localInbox,
    body: "Hallo Bob,\n\nviele Grüße aus München.\n\nJörg",
  });
  push({
    id: "103",
    headerMessageId: "msg-3@example.org",
    subject: "Re: project update",
    author: "Carol <carol@example.org>",
    recipients: ["Bob Example <bob@example.net>"],
    date: "2024-01-03T09:15:00.000Z",
    read: true,
    flagged: false,
    folderId: localInbox,
    body: "Here is the plain text version of the project update.\n\nHere is the HTML version of the project update.",
  });
  push({
    id: "104",
    headerMessageId: "draft-1@example.com",
    subject: "Unfinished draft",
    author: "Alice Example <alice@example.com>",
    recipients: ["Bob Example <bob@example.net>"],
    date: "2024-01-04T12:00:00.000Z",
    read: true,
    flagged: false,
    folderId: localDrafts,
    body: "This draft already existed before the MCP server wrote anything.",
  });
  push({
    id: "105",
    headerMessageId: "msg-4@example.net",
    subject: "IMAP inbox message",
    author: "Eve <eve@example.net>",
    recipients: ["Bob Example <bob@example.net>"],
    date: "2024-01-05T08:00:00.000Z",
    read: false,
    flagged: false,
    folderId: imapInbox,
    body: "This one lives in the IMAP account folder and mentions a quarterly report.\n\nEve",
  });

  return state;
}
