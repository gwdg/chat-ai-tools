export type FolderKind =
  | "inbox"
  | "drafts"
  | "sent"
  | "trash"
  | "templates"
  | "archives"
  | "junk"
  | "other";

export type FolderFormat = "extension";

export interface ProfileCandidate {
  root: string;
  name: string;
  isDefault: boolean;
  source: string;
}

export interface AccountIdentity {
  id: string;
  email: string;
  name?: string;
  draftFolderUri?: string;
  sentFolderUri?: string;
}

export interface Account {
  key: string;
  serverKey: string;
  type: string;
  hostname?: string;
  label: string;
  userName?: string;
  identities: AccountIdentity[];
}

export interface FolderInfo {
  id: string;
  name: string;
  path: string;
  accountKey: string;
  accountLabel: string;
  kind: FolderKind;
  format: FolderFormat;
  filePath: string;
  exists: boolean;
  special: boolean;
  messageCount?: number;
  unreadCount?: number;
}

export interface EmailAddress {
  name?: string;
  email: string;
}

export interface MessageSummary {
  id: string;
  folder: string;
  folderName: string;
  index: number;
  subject: string;
  from: EmailAddress[];
  to: EmailAddress[];
  cc: EmailAddress[];
  date: string | null;
  dateRaw: string | null;
  messageId: string | null;
  inReplyTo: string | null;
  references: string[];
  conversationId?: string;
  conversationSize?: number;
  read: boolean;
  flagged: boolean;
  priority?: string;
  replied: boolean;
  hasAttachments: boolean;
  snippet?: string;
  salutation?: string;
  extensionId?: string;
}

export interface ParsedMessage {
  id: string;
  folder: string;
  folderName: string;
  index: number;
  subject: string;
  from: EmailAddress[];
  to: EmailAddress[];
  cc: EmailAddress[];
  bcc: EmailAddress[];
  replyTo: EmailAddress[];
  date: string | null;
  dateRaw: string | null;
  messageId: string | null;
  inReplyTo: string | null;
  references: string[];
  text: string;
  html?: string;
  attachments: Array<{
    filename: string;
    contentType: string;
    size: number;
  }>;
  read: boolean;
  flagged: boolean;
  replied: boolean;
  headers: Record<string, string>;
}

export interface ProfileContext {
  root: string;
  name: string;
  accounts: Account[];
  folders: FolderInfo[];
  identities: AccountIdentity[];
}

export interface DraftAttachment {
  filename: string;
  contentType?: string;
  contentBase64: string;
}

export interface DraftInput {
  from: { name?: string; email: string };
  to: EmailAddress[];
  cc: EmailAddress[];
  bcc: EmailAddress[];
  subject: string;
  text?: string;
  html?: string;
  inReplyTo?: string;
  references?: string[];
  attachments?: DraftAttachment[];
}

export interface CreatedDraft {
  id: string;
  folder: string;
  folderName: string;
  filePath: string;
  format: FolderFormat;
  messageId: string;
  date: string;
  warning?: string;
}
