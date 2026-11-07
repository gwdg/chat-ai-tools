import type { MessageSummary } from "./types.js";

export interface ConversationInfo {
  conversationId: string;
  conversationSize: number;
  normalizedSubject: string;
}

const SUBJECT_PREFIX = /^\s*(?:(?:re|fwd|fw|aw|wg|antw|sv|tr|vs|enc)\s*:\s*)+/i;

export function normalizeSubject(subject: string): string {
  let value = subject;
  let previous = "";
  while (value !== previous) {
    previous = value;
    value = value.replace(SUBJECT_PREFIX, "");
  }
  return value.replace(/\s+/g, " ").trim().toLowerCase();
}

export function normalizeMessageId(value: string | null | undefined): string {
  if (!value) return "";
  return value.trim().replace(/^<|>$/g, "").trim().toLowerCase();
}

class UnionFind {
  private parent: number[];

  constructor(size: number) {
    this.parent = Array.from({ length: size }, (_, index) => index);
  }

  find(index: number): number {
    let root = index;
    while (this.parent[root] !== root) root = this.parent[root];
    let current = index;
    while (this.parent[current] !== current) {
      const next = this.parent[current];
      this.parent[current] = root;
      current = next;
    }
    return root;
  }

  union(left: number, right: number): void {
    const leftRoot = this.find(left);
    const rightRoot = this.find(right);
    if (leftRoot !== rightRoot) this.parent[rightRoot] = leftRoot;
  }
}

export function assignConversations(
  messages: MessageSummary[],
  scope: string,
): ConversationInfo[] {
  const count = messages.length;
  const unionFind = new UnionFind(count);
  const normalizedSubjects = messages.map((message) => normalizeSubject(message.subject));
  const byMessageId = new Map<string, number>();
  const bySubject = new Map<string, number>();

  messages.forEach((message, index) => {
    const messageId = normalizeMessageId(message.messageId);
    if (messageId) byMessageId.set(messageId, index);
  });

  messages.forEach((message, index) => {
    const referenceIds = [...message.references, ...(message.inReplyTo ? [message.inReplyTo] : [])]
      .map(normalizeMessageId)
      .filter(Boolean);
    let linked = false;
    for (const referenceId of referenceIds) {
      const target = byMessageId.get(referenceId);
      if (target !== undefined && target !== index) {
        unionFind.union(index, target);
        linked = true;
      }
    }

    if (!linked) {
      const subject = normalizedSubjects[index];
      if (subject) {
        const target = bySubject.get(subject);
        if (target !== undefined) unionFind.union(index, target);
        else bySubject.set(subject, index);
      }
    }
  });

  const groups = new Map<number, number[]>();
  for (let index = 0; index < count; index += 1) {
    const root = unionFind.find(index);
    const members = groups.get(root);
    if (members) members.push(index);
    else groups.set(root, [index]);
  }

  const result: ConversationInfo[] = new Array(count);
  for (const members of groups.values()) {
    let representative = members[0];
    for (const member of members) {
      if (normalizeMessageId(messages[member].messageId)) {
        representative = member;
        break;
      }
    }
    const messageId = normalizeMessageId(messages[representative].messageId);
    const normalizedSubject = normalizedSubjects[representative] ?? "";
    const conversationId = messageId || `subject:${scope}:${normalizedSubject || "unknown"}`;
    for (const member of members) {
      result[member] = {
        conversationId,
        conversationSize: members.length,
        normalizedSubject,
      };
    }
  }
  return result;
}
