import { randomUUID } from "node:crypto";
import {
  mkdir,
  readFile,
  rename,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { createConnection, type Socket } from "node:net";
import path from "node:path";

export interface ExtensionResponse {
  id?: string;
  ok: boolean;
  result?: unknown;
  error?: string;
}

export interface ExtensionMarkResult {
  attempted: boolean;
  ok: boolean;
  error?: string;
  result?: unknown;
}

function bridgeDirectory(profileRoot: string, kind: string): string {
  return path.join(profileRoot, "thunderbird-mcp-bridge", kind);
}

const SOCKET_INFO_FILE = "socket.json";
const SOCKET_FILE_NAMES = ["mcp.sock", "s"];
const SOCKET_CONNECT_TIMEOUT_MS = 2000;

function bridgeRoot(profileRoot: string): string {
  return path.join(profileRoot, "thunderbird-mcp-bridge");
}

function asciiJson(value: unknown): string {
  return JSON.stringify(value).replace(/[\u0080-\uffff]/g, (match) => {
    return "\\u" + match.charCodeAt(0).toString(16).padStart(4, "0");
  });
}

function isTimeoutError(error: unknown): boolean {
  return error instanceof Error && /did not respond in time/i.test(error.message);
}

async function isUnixSocket(file: string): Promise<boolean> {
  try {
    return (await stat(file)).isSocket();
  } catch {
    return false;
  }
}

export async function resolveBridgeSocket(
  profileRoot: string,
): Promise<string | undefined> {
  const root = bridgeRoot(profileRoot);
  try {
    const info = JSON.parse(
      await readFile(path.join(root, SOCKET_INFO_FILE), "utf8"),
    ) as { path?: unknown };
    if (typeof info.path === "string" && (await isUnixSocket(info.path))) {
      return info.path;
    }
  } catch {
    // Fall through to the conventional paths.
  }
  for (const name of SOCKET_FILE_NAMES) {
    const candidate = path.join(root, name);
    if (await isUnixSocket(candidate)) return candidate;
  }
  return undefined;
}

interface PendingSocketResponse {
  resolve: (response: ExtensionResponse) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

class ExtensionSocketClient {
  private socket?: Socket;
  private connecting?: Promise<Socket>;
  private buffer = "";
  private readonly pending = new Map<string, PendingSocketResponse>();

  constructor(private readonly socketPath: string) {}

  private connect(): Promise<Socket> {
    if (this.socket && !this.socket.destroyed) return Promise.resolve(this.socket);
    if (this.connecting) return this.connecting;

    this.connecting = new Promise<Socket>((resolve, reject) => {
      const socket = createConnection({ path: this.socketPath });
      const timer = setTimeout(() => {
        socket.destroy();
        const error = new Error(`Timed out connecting to ${this.socketPath}`);
        (error as NodeJS.ErrnoException).code = "SOCKET_CONNECT_TIMEOUT";
        reject(error);
      }, SOCKET_CONNECT_TIMEOUT_MS);

      socket.once("connect", () => {
        clearTimeout(timer);
        this.socket = socket;
        socket.setNoDelay(true);
        socket.on("data", (chunk) => this.onData(chunk));
        socket.on("error", (error) => this.onClose(error));
        socket.on("close", () => this.onClose(new Error("Connection closed")));
        resolve(socket);
      });
      socket.once("error", (error) => {
        clearTimeout(timer);
        socket.destroy();
        reject(error);
      });
    }).finally(() => {
      this.connecting = undefined;
    });

    return this.connecting;
  }

  private onData(chunk: Buffer | string): void {
    this.buffer += chunk.toString();
    let newline = this.buffer.indexOf("\n");
    while (newline >= 0) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      newline = this.buffer.indexOf("\n");
      if (!line) continue;
      try {
        const response = JSON.parse(line) as ExtensionResponse;
        if (typeof response.id !== "string") continue;
        const pending = this.pending.get(response.id);
        if (!pending) continue;
        this.pending.delete(response.id);
        clearTimeout(pending.timer);
        pending.resolve(response);
      } catch {
        // Ignore malformed frames; the request timeout will surface the failure.
      }
    }
  }

  private onClose(cause: Error): void {
    const socket = this.socket;
    this.socket = undefined;
    this.buffer = "";
    try {
      socket?.destroy();
    } catch {
      // Already closed.
    }
    const error = new Error("Lost connection to the Thunderbird extension.");
    (error as NodeJS.ErrnoException).code = "SOCKET_LOST";
    (error as { cause?: unknown }).cause = cause;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  async request(
    command: Record<string, unknown>,
    timeoutMs: number,
  ): Promise<ExtensionResponse> {
    const socket = await this.connect();
    const id = randomUUID();
    return new Promise<ExtensionResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("The Thunderbird extension did not respond in time."));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        socket.write(`${asciiJson({ ...command, id })}\n`);
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        const wrapped = new Error(
          "Lost connection to the Thunderbird extension.",
        );
        (wrapped as NodeJS.ErrnoException).code = "SOCKET_LOST";
        (wrapped as { cause?: unknown }).cause = error;
        reject(wrapped);
      }
    });
  }
}

const socketClients = new Map<string, ExtensionSocketClient>();

async function socketClientFor(
  profileRoot: string,
): Promise<ExtensionSocketClient | undefined> {
  const socketPath = await resolveBridgeSocket(profileRoot);
  if (!socketPath) return undefined;
  const key = `${profileRoot}\u0000${socketPath}`;
  let client = socketClients.get(key);
  if (!client) {
    client = new ExtensionSocketClient(socketPath);
    socketClients.set(key, client);
  }
  return client;
}

async function fileExtensionAvailable(profileRoot: string): Promise<boolean> {
  try {
    const text = await readFile(
      path.join(profileRoot, "thunderbird-mcp-bridge", "status.json"),
      "utf8",
    );
    const status = JSON.parse(text) as { time?: unknown };
    return typeof status.time === "number" && Date.now() - status.time < 5000;
  } catch {
    return false;
  }
}

async function callFileExtension(
  profileRoot: string,
  command: Record<string, unknown>,
  timeoutMs = 5000,
): Promise<ExtensionResponse | null> {
  const commands = bridgeDirectory(profileRoot, "commands");
  const results = bridgeDirectory(profileRoot, "results");
  await mkdir(commands, { recursive: true });
  await mkdir(results, { recursive: true });

  const id = randomUUID();
  const commandFile = path.join(commands, `${id}.json`);
  const temporary = `${commandFile}.tmp`;
  await writeFile(temporary, JSON.stringify({ ...command, id }, null, 2), "utf8");
  await rename(temporary, commandFile);

  const resultFile = path.join(results, `${id}.json`);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const text = await readFile(resultFile, "utf8");
      const response = JSON.parse(text) as ExtensionResponse;
      await unlink(resultFile).catch(() => undefined);
      return response;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }

  await unlink(commandFile).catch(() => undefined);
  return null;
}

async function callViaSocket(
  profileRoot: string,
  command: Record<string, unknown>,
  timeoutMs: number,
): Promise<ExtensionResponse | undefined> {
  const client = await socketClientFor(profileRoot);
  if (!client) return undefined;
  try {
    return await client.request(command, timeoutMs);
  } catch (error) {
    if (isTimeoutError(error)) throw error;
    if ((error as NodeJS.ErrnoException).code === "SOCKET_LOST") throw error;
    return undefined;
  }
}

export async function extensionAvailable(profileRoot: string): Promise<boolean> {
  const client = await socketClientFor(profileRoot);
  if (client) {
    try {
      const response = await client.request({ command: "ping" }, 1500);
      if (response.ok) return true;
    } catch {
      // Fall back to the file heartbeat.
    }
  }
  return fileExtensionAvailable(profileRoot);
}

export async function callExtension(
  profileRoot: string,
  command: Record<string, unknown>,
  timeoutMs = 5000,
): Promise<ExtensionResponse | null> {
  const viaSocket = await callViaSocket(profileRoot, command, timeoutMs);
  if (viaSocket !== undefined) return viaSocket;
  return callFileExtension(profileRoot, command, timeoutMs);
}

export async function markViaExtension(
  profileRoot: string,
  messageId: string | undefined,
  read: boolean | undefined,
  answered: boolean | undefined,
  extensionId?: string,
  folderId?: string,
  priority?: number,
): Promise<ExtensionMarkResult> {
  if (!(await extensionAvailable(profileRoot))) {
    return { attempted: false, ok: false };
  }

  let response: ExtensionResponse | null;
  try {
    response = await callExtension(
      profileRoot,
      {
        command: "mark",
        ...(extensionId ? { messageId: extensionId } : {}),
        ...(folderId
          ? { folderId, accountKey: folderId.split("://")[0] }
          : {}),
        ...(messageId ? { headerMessageId: messageId } : {}),
        ...(read === undefined ? {} : { read }),
        ...(answered === undefined ? {} : { answered }),
        ...(priority === undefined ? {} : { priority }),
      },
      5000,
    );
  } catch (error) {
    return {
      attempted: true,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }

  if (!response) {
    return { attempted: true, ok: false, error: "Extension timed out." };
  }
  return {
    attempted: true,
    ok: response.ok,
    error: response.error,
    result: response.result,
  };
}

export interface ExtensionRawMessage {
  messageId: string;
  raw: string;
  read?: boolean;
  flagged?: boolean;
  headerMessageId?: string;
}

export interface ExtensionMessage {
  id: string;
  headerMessageId?: string;
  subject?: string;
  author?: string;
  recipients?: string[];
  ccList?: string[];
  bccList?: string[];
  date?: string;
  read?: boolean;
  flagged?: boolean;
  priority?: string;
  preview?: string;
  salutation?: string;
  folder?: { id?: string; name?: string; path?: string; accountId?: string };
}

export const MESSAGE_PRIORITIES = {
  none: 1,
  lowest: 2,
  low: 3,
  normal: 4,
  high: 5,
  highest: 6,
} as const;

export type MessagePriority = keyof typeof MESSAGE_PRIORITIES;

export async function setPriorityViaExtension(
  profileRoot: string,
  messageId: string | undefined,
  priority: MessagePriority,
  extensionId?: string,
  folderId?: string,
): Promise<ExtensionMarkResult> {
  return markViaExtension(
    profileRoot,
    messageId,
    undefined,
    undefined,
    extensionId,
    folderId,
    MESSAGE_PRIORITIES[priority],
  );
}

export interface ExtensionPreview {
  id: string;
  preview?: string;
  salutation?: string;
  error?: string;
}

export interface ExtensionIdentity {
  id?: string;
  email?: string;
  name?: string;
  label?: string;
}

export interface ExtensionFolder {
  id: string;
  name: string;
  path: string;
  specialUse?: string[];
  accountId?: string;
  accountName?: string;
  accountType?: string;
  isRoot?: boolean;
  isVirtual?: boolean;
  totalMessageCount?: number;
  unreadMessageCount?: number;
  newMessageCount?: number;
  lastUsed?: string;
}

export interface ExtensionAccount {
  id: string;
  name: string;
  type?: string;
  identities: ExtensionIdentity[];
  folders: ExtensionFolder[];
}

export interface ExtensionDraftAttachment {
  filename: string;
  contentType?: string;
  contentBase64: string;
}

export interface ExtensionDraftInput {
  identityEmail: string;
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  text?: string;
  html?: string;
  inReplyTo?: string;
  references?: string[];
  attachments?: ExtensionDraftAttachment[];
}

async function requireExtension(
  profileRoot: string,
  command: Record<string, unknown>,
  timeoutMs = 15000,
): Promise<ExtensionResponse> {
  const viaSocket = await callViaSocket(profileRoot, command, timeoutMs);
  if (viaSocket !== undefined) {
    if (!viaSocket.ok) {
      throw new Error(viaSocket.error || "The Thunderbird extension reported an error.");
    }
    return viaSocket;
  }

  if (!(await fileExtensionAvailable(profileRoot))) {
    throw new Error(
      "Thunderbird is not running with the MCP extension loaded. Start Thunderbird and load the thunderbird-extension.",
    );
  }
  const response = await callFileExtension(profileRoot, command, timeoutMs);
  if (!response) {
    throw new Error("The Thunderbird extension did not respond in time.");
  }
  if (!response.ok) {
    throw new Error(response.error || "The Thunderbird extension reported an error.");
  }
  return response;
}

export async function readRawFromExtension(
  profileRoot: string,
  messageId: string | undefined,
  headerMessageId: string | undefined,
): Promise<ExtensionRawMessage> {
  const response = await requireExtension(profileRoot, {
    command: "read",
    ...(messageId ? { messageId } : {}),
    ...(headerMessageId ? { headerMessageId } : {}),
  });
  return response.result as ExtensionRawMessage;
}

export interface ExtensionSearchOptions {
  query?: string;
  author?: string;
  recipients?: string;
  subject?: string;
  body?: string;
  folderId?: string;
  folderIds?: string[];
  unreadOnly?: boolean;
  flagged?: boolean;
  hasAttachment?: boolean;
  fromDate?: string;
  toDate?: string;
  tags?: Record<string, boolean>;
  tagMode?: "all" | "any" | "none";
  sizeMin?: number;
  sizeMax?: number;
  limit?: number;
  offset?: number;
}

export async function searchViaExtension(
  profileRoot: string,
  options: ExtensionSearchOptions = {},
): Promise<ExtensionMessage[]> {
  const response = await requireExtension(
    profileRoot,
    {
      command: "search",
      ...options,
      limit: options.limit ?? 50,
      offset: options.offset ?? 0,
    },
    60000,
  );
  return (response.result as { messages: ExtensionMessage[] }).messages;
}

export async function saveDraftViaExtension(
  profileRoot: string,
  draft: ExtensionDraftInput,
): Promise<ExtensionMessage[]> {
  const response = await requireExtension(
    profileRoot,
    { command: "saveDraft", ...draft },
    30000,
  );
  return (response.result as { messages: ExtensionMessage[] }).messages;
}

export async function listAccountsViaExtension(
  profileRoot: string,
): Promise<ExtensionAccount[]> {
  const response = await requireExtension(profileRoot, { command: "accounts" }, 15000);
  return (response.result as { accounts: ExtensionAccount[] }).accounts;
}

export async function listFoldersViaExtension(
  profileRoot: string,
  counts = false,
): Promise<ExtensionFolder[]> {
  const response = await requireExtension(
    profileRoot,
    { command: "folders", counts },
    30000,
  );
  return (response.result as { folders: ExtensionFolder[] }).folders;
}

export interface ExtensionMessagePage {
  folder?: ExtensionFolder;
  messages: ExtensionMessage[];
}

export async function listMessagePageViaExtension(
  profileRoot: string,
  options: {
    folderId?: string;
    folderPath?: string;
    accountLabel?: string;
    unreadOnly?: boolean;
    fromDate?: string;
    toDate?: string;
    limit?: number;
    offset?: number;
    includePreview?: boolean;
  },
): Promise<ExtensionMessagePage> {
  const response = await requireExtension(
    profileRoot,
    {
      command: "list",
      ...(options.folderId ? { folderId: options.folderId } : {}),
      ...(options.folderPath ? { folderPath: options.folderPath } : {}),
      ...(options.accountLabel ? { accountLabel: options.accountLabel } : {}),
      ...(options.unreadOnly ? { unreadOnly: true } : {}),
      ...(options.fromDate ? { fromDate: options.fromDate } : {}),
      ...(options.toDate ? { toDate: options.toDate } : {}),
      limit: options.limit ?? 5000,
      offset: options.offset ?? 0,
      ...(options.includePreview ? { includePreview: true } : {}),
    },
    60000,
  );
  return response.result as ExtensionMessagePage;
}

export async function listMessagesViaExtension(
  profileRoot: string,
  options: {
    folderId?: string;
    folderPath?: string;
    accountLabel?: string;
    unreadOnly?: boolean;
    fromDate?: string;
    toDate?: string;
    limit?: number;
    offset?: number;
    includePreview?: boolean;
  },
): Promise<ExtensionMessage[]> {
  return (await listMessagePageViaExtension(profileRoot, options)).messages;
}

export async function previewMessagesViaExtension(
  profileRoot: string,
  messageIds: string[],
  maxLines = 6,
): Promise<Map<string, ExtensionPreview>> {
  if (!messageIds.length) return new Map();
  const response = await requireExtension(
    profileRoot,
    {
      command: "preview",
      messageIds,
      maxLines,
    },
    120000,
  );
  const previews = (response.result as { previews?: ExtensionPreview[] }).previews ?? [];
  return new Map(previews.map((preview) => [String(preview.id), preview]));
}
