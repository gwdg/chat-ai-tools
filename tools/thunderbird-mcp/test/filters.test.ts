import assert from "node:assert/strict";
import test from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { createServer } from "../src/server.js";
import { makeTempProfile } from "./helpers.js";
import { makeFakeState, startFakeExtension } from "./fake-extension.js";

function payload(result: Awaited<ReturnType<Client["callTool"]>>): unknown {
  assert.equal(result.isError, undefined);
  const content = result.content as Array<{ type: string; text?: string }>;
  const text = content.find((item) => item.type === "text")?.text;
  assert.ok(text);
  return JSON.parse(text);
}

interface ListedMessage {
  subject: string;
  from: Array<{ name?: string; email: string }>;
  conversationId: string;
  conversationSize: number;
  read: boolean;
}

interface ListedResult {
  total: number;
  matched: number;
  messages: ListedMessage[];
}

async function withServer(
  profileRoot: string,
  action: (client: Client) => Promise<void>,
): Promise<void> {
  const server = createServer({
    profile: profileRoot,
    readOnly: true,
    confirmAction: async () => "session",
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "filters-tests", version: "1.0.0" });
  await client.connect(clientTransport);
  try {
    await action(client);
  } finally {
    await client.close();
    await server.close();
  }
}

async function listEmails(
  client: Client,
  args: Record<string, unknown>,
): Promise<ListedResult> {
  return payload(
    await client.callTool({
      name: "list_emails",
      arguments: { folder: "Local Folders/Inbox", limit: 100, includeSnippet: false, ...args },
    }),
  ) as ListedResult;
}

test("filters by sender, subject, unread state, and conversation combinations", async () => {
  const profile = makeTempProfile();
  const state = makeFakeState();
  state.messages.push({
    id: "106",
    headerMessageId: "msg-6@example.com",
    subject: "Re: Welcome to Thunderbird",
    author: "Alice Example <alice@example.com>",
    recipients: ["Bob Example <bob@example.net>"],
    date: "2024-01-04T12:00:00.000Z",
    read: false,
    flagged: false,
    folderId: "folder-local-inbox",
    raw: [
      "From: Alice Example <alice@example.com>",
      "To: Bob Example <bob@example.net>",
      "Subject: Re: Welcome to Thunderbird",
      "Date: Thu, 04 Jan 2024 12:00:00 +0000",
      "Message-ID: <msg-6@example.com>",
      "Content-Type: text/plain; charset=UTF-8",
      "",
      "A reply in the same conversation.",
    ].join("\n"),
  });
  const extension = startFakeExtension(profile.root, state);
  try {
    await withServer(profile.root, async (client) => {
      const bySender = await listEmails(client, { from: "alice@example.com" });
      assert.equal(bySender.matched, 2);

      const bySenderName = await listEmails(client, { sender: "Alice Example" });
      assert.equal(bySenderName.matched, 2);

      const bySubject = await listEmails(client, { subject: "grüße" });
      assert.equal(bySubject.matched, 1);
      assert.equal(bySubject.messages[0].subject, "Grüße aus München");

      const byTitleAlias = await listEmails(client, { title: "project update" });
      assert.equal(byTitleAlias.matched, 1);

      const unreadFromAlice = await listEmails(client, {
        unreadOnly: true,
        from: "alice",
      });
      assert.equal(unreadFromAlice.matched, 2);

      const conversationByMessageId = await listEmails(client, {
        conversation: "<msg-1@example.com>",
      });
      assert.equal(conversationByMessageId.matched, 2);
      assert.deepEqual(
        conversationByMessageId.messages.map((message) => message.conversationId),
        ["msg-1@example.com", "msg-1@example.com"],
      );
      assert.deepEqual(
        conversationByMessageId.messages.map((message) => message.conversationSize),
        [2, 2],
      );

      const conversationBySubject = await listEmails(client, {
        conversation: "subject:Welcome to Thunderbird",
      });
      assert.equal(conversationBySubject.matched, 2);

      const combined = await listEmails(client, {
        from: "Alice",
        subject: "welcome",
        unreadOnly: true,
        conversation: "msg-1@example.com",
      });
      assert.equal(combined.matched, 2);
      assert.equal(combined.total, 4);
    });
  } finally {
    extension.stop();
    profile.cleanup();
  }
});

test("search_emails accepts the same structured filters", async () => {
  const profile = makeTempProfile();
  const state = makeFakeState();
  const extension = startFakeExtension(profile.root, state);
  try {
    await withServer(profile.root, async (client) => {
      const result = payload(
        await client.callTool({
          name: "search_emails",
          arguments: {
            query: "project update",
            folder: "Local Folders/Inbox",
            from: "carol",
            subject: "project",
          },
        }),
      ) as { matches: Array<{ subject: string }> };
      assert.equal(result.matches.length, 1);
      assert.equal(result.matches[0].subject, "Re: project update");
    });
  } finally {
    extension.stop();
    profile.cleanup();
  }
});
