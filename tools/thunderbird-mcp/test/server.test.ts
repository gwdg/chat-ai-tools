import assert from "node:assert/strict";
import test from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { ConfirmationRequest } from "../src/dialog.js";
import { createServer } from "../src/server.js";
import { makeTempProfile } from "./helpers.js";
import { makeFakeState, startFakeExtension } from "./fake-extension.js";

interface TestConnection {
  client: Client;
  server: McpServer;
  close: () => Promise<void>;
}

async function connect(
  profile: string,
  readOnly = false,
  confirmAction = async () => "session" as const,
): Promise<TestConnection> {
  const server = createServer({ profile, readOnly, confirmAction });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "thunderbird-mcp-tests", version: "1.0.0" });
  await client.connect(clientTransport);
  return {
    client,
    server,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

function payload(result: Awaited<ReturnType<Client["callTool"]>>): unknown {
  assert.equal(result.isError, undefined);
  const content = result.content as Array<{ type: string; text?: string }>;
  const text = content.find((item) => item.type === "text")?.text;
  assert.ok(text);
  return JSON.parse(text);
}

test("MCP server exposes extension-backed tools and creates drafts", async () => {
  const profile = makeTempProfile();
  const state = makeFakeState();
  const extension = startFakeExtension(profile.root, state);
  const connection = await connect(profile.root);
  try {
    const tools = await connection.client.listTools();
    const names = tools.tools.map((tool) => tool.name).sort();
    assert.deepEqual(names, [
      "create_draft",
      "list_accounts",
      "list_emails",
      "list_folders",
      "list_profiles",
      "list_session_approvals",
      "read_email",
      "search_emails",
      "set_email_answered",
      "set_email_priority",
      "set_email_read",
    ]);

    const listed = payload(
      await connection.client.callTool({
        name: "list_emails",
        arguments: { folder: "Local Folders/Inbox", limit: 10 },
      }),
    ) as { total: number; messages: Array<{ id: string; subject: string }> };
    assert.equal(listed.total, 3);
    assert.equal(listed.messages.length, 3);
    assert.equal(listed.messages[0].subject, "Re: project update");

    const message = payload(
      await connection.client.callTool({
        name: "read_email",
        arguments: { id: listed.messages[0].id, includeHtml: true },
      }),
    ) as { subject: string; text: string; read: boolean };
    assert.equal(message.subject, "Re: project update");
    assert.match(message.text, /plain text version/);
    assert.equal(message.read, true);

    const found = payload(
      await connection.client.callTool({
        name: "search_emails",
        arguments: { query: "HTML version", includeBody: true },
      }),
    ) as { matches: Array<{ subject: string; matchedIn: string[] }> };
    assert.equal(found.matches.length, 1);
    assert.equal(found.matches[0].subject, "Re: project update");
    assert.deepEqual(found.matches[0].matchedIn, ["body"]);

    const created = payload(
      await connection.client.callTool({
        name: "create_draft",
        arguments: {
          from: "alice@example.com",
          to: ["Carol <carol@example.org>", "Dave <dave@example.org>"],
          subject: "MCP draft",
          text: "Hello from MCP",
        },
      }),
    ) as { folderName: string; format: string; id: string };
    assert.equal(created.folderName, "Drafts");
    assert.equal(created.format, "extension");
    assert.equal(state.savedDrafts.length, 1);
    assert.deepEqual(state.savedDrafts[0].to, [
      "Carol <carol@example.org>",
      "Dave <dave@example.org>",
    ]);

    const draft = payload(
      await connection.client.callTool({
        name: "read_email",
        arguments: { id: created.id },
      }),
    ) as { subject: string; text: string };
    assert.equal(draft.subject, "MCP draft");
    assert.match(draft.text, /Hello from MCP/);
  } finally {
    await connection.close();
    extension.stop();
    profile.cleanup();
  }
});

test("create_draft quotes the original message for replies", async () => {
  const profile = makeTempProfile();
  const state = makeFakeState();
  const extension = startFakeExtension(profile.root, state);
  const connection = await connect(profile.root);
  try {
    const created = payload(
      await connection.client.callTool({
        name: "create_draft",
        arguments: {
          from: "alice@example.com",
          to: ["Carol <carol@example.org>"],
          subject: "Re: project update",
          text: "Thanks for the update.",
          inReplyTo: "<msg-3@example.org>",
          markReplied: true,
        },
      }),
    ) as { id: string; quoteIncluded: boolean; replyMarked: boolean };
    assert.equal(created.quoteIncluded, true);
    assert.equal(created.replyMarked, true);
    assert.equal(state.marked.length, 1);

    const draft = payload(
      await connection.client.callTool({
        name: "read_email",
        arguments: { id: created.id },
      }),
    ) as { text: string };
    assert.match(draft.text, /> Here is the plain text version/);
    assert.match(draft.text, /wrote:/);

    const notMarked = payload(
      await connection.client.callTool({
        name: "create_draft",
        arguments: {
          from: "alice@example.com",
          to: ["Carol <carol@example.org>"],
          subject: "Re: project update",
          text: "One more note.",
          inReplyTo: "<msg-3@example.org>",
        },
      }),
    ) as { replyMarked: boolean };
    assert.equal(notMarked.replyMarked, false);
  } finally {
    await connection.close();
    extension.stop();
    profile.cleanup();
  }
});

test("read-only mode hides create_draft", async () => {
  const profile = makeTempProfile();
  const state = makeFakeState();
  const extension = startFakeExtension(profile.root, state);
  const connection = await connect(profile.root, true);
  try {
    const tools = await connection.client.listTools();
    assert.equal(tools.tools.some((tool) => tool.name === "create_draft"), false);
    assert.equal(tools.tools.some((tool) => tool.name === "set_email_read"), false);
    assert.equal(tools.tools.some((tool) => tool.name === "set_email_priority"), false);
    assert.equal(tools.tools.some((tool) => tool.name === "set_email_answered"), false);
  } finally {
    await connection.close();
    extension.stop();
    profile.cleanup();
  }
});

test("set_email_priority changes the priority through the extension", async () => {
  const profile = makeTempProfile();
  const state = makeFakeState();
  const extension = startFakeExtension(profile.root, state);
  const connection = await connect(profile.root);
  try {
    const listed = payload(
      await connection.client.callTool({
        name: "list_emails",
        arguments: { folder: "Local Folders/Inbox", limit: 10, includeSnippet: false },
      }),
    ) as { messages: Array<{ id: string }> };

    const changed = payload(
      await connection.client.callTool({
        name: "set_email_priority",
        arguments: { id: listed.messages[0].id, priority: "high" },
      }),
    ) as { priority: string; via: string };
    assert.equal(changed.priority, "high");
    assert.equal(changed.via, "extension");
    assert.equal(state.marked.length, 1);
    assert.equal(state.marked[0].priority, 5);

    const changedAgain = await connection.client.callTool({
      name: "set_email_priority",
      arguments: { id: listed.messages[0].id, priority: "low" },
    });
    assert.equal(changedAgain.isError, undefined);
    assert.equal(state.marked[1].priority, 3);
  } finally {
    await connection.close();
    extension.stop();
    profile.cleanup();
  }
});

test("read tools ask for native access approval and remember it", async () => {
  const profile = makeTempProfile();
  const state = makeFakeState();
  const extension = startFakeExtension(profile.root, state);
  const prompts: ConfirmationRequest[] = [];
  const connection = await connect(profile.root, false, async (request) => {
    prompts.push(request);
    return prompts.length === 1 ? "deny" : "session";
  });
  try {
    const denied = await connection.client.callTool({
      name: "list_emails",
      arguments: { folder: "Local Folders/Inbox", limit: 10, includeSnippet: false },
    });
    assert.equal(denied.isError, true);
    assert.equal(prompts.length, 1);
    assert.match(prompts[0].action, /^list emails in /);
    assert.match(prompts[0].details, /Mailbox: /);
    assert.match(prompts[0].details, /Account: /);

    const first = payload(
      await connection.client.callTool({
        name: "list_emails",
        arguments: { folder: "Local Folders/Inbox", limit: 10, includeSnippet: false },
      }),
    ) as { messages: Array<{ id: string }> };
    assert.equal(first.messages.length, 3);
    assert.equal(prompts.length, 2);

    const second = payload(
      await connection.client.callTool({
        name: "list_emails",
        arguments: { folder: "Local Folders/Inbox", limit: 10, includeSnippet: false },
      }),
    ) as { messages: Array<{ id: string }> };
    assert.equal(second.messages.length, 3);
    assert.equal(prompts.length, 2);

    await connection.client.callTool({
      name: "list_emails",
      arguments: { folder: "Drafts", limit: 10, includeSnippet: false },
    });
    assert.equal(prompts.length, 3);
    assert.match(prompts[2].action, /^list emails in /);
    assert.match(prompts[2].details, /Mailbox: Drafts/);

    await connection.client.callTool({ name: "list_accounts", arguments: {} });
    assert.equal(prompts.length, 4);
    assert.equal(
      prompts[3].action,
      "read the list of Thunderbird accounts and identities",
    );
    await connection.client.callTool({ name: "list_folders", arguments: {} });
    assert.equal(prompts.length, 4);
  } finally {
    await connection.close();
    extension.stop();
    profile.cleanup();
  }
});

test("set_email_read asks for confirmation and remembers a session approval", async () => {
  const profile = makeTempProfile();
  const state = makeFakeState();
  const extension = startFakeExtension(profile.root, state);
  const denied = await connect(profile.root, false, async () => "deny");
  const connection = await connect(profile.root);
  try {
    const listed = payload(
      await connection.client.callTool({
        name: "list_emails",
        arguments: { folder: "Local Folders/Inbox", limit: 10, includeSnippet: false },
      }),
    ) as { messages: Array<{ id: string }> };

    const refused = await denied.client.callTool({
      name: "set_email_read",
      arguments: { id: listed.messages[0].id, read: true },
    });
    assert.equal(refused.isError, true);

    const marked = payload(
      await connection.client.callTool({
        name: "set_email_read",
        arguments: { id: listed.messages[0].id, read: true },
      }),
    ) as { marked: boolean; via: string };
    assert.equal(marked.marked, true);
    assert.equal(marked.via, "extension");
    assert.equal(state.marked.length, 1);
    assert.equal(state.messages.find((message) => message.id === "103")?.read, true);

    const approvals = payload(
      await connection.client.callTool({
        name: "list_session_approvals",
        arguments: {},
      }),
    ) as { approvals: string[] };
    assert.ok(
      approvals.approvals.some((key) => key.startsWith("set_email_read:")),
    );
  } finally {
    await denied.close();
    await connection.close();
    extension.stop();
    profile.cleanup();
  }
});

test("list_accounts and list_folders use extension metadata", async () => {
  const profile = makeTempProfile();
  const state = makeFakeState();
  const extension = startFakeExtension(profile.root, state);
  const connection = await connect(profile.root);
  try {
    const accounts = payload(
      await connection.client.callTool({ name: "list_accounts", arguments: {} }),
    ) as { accounts: Array<{ label: string; identities: Array<{ email: string }> }> };
    assert.equal(accounts.accounts.length, 2);
    assert.deepEqual(accounts.accounts[0].identities.map((item) => item.email), [
      "alice@example.com",
    ]);

    const folders = payload(
      await connection.client.callTool({
        name: "list_folders",
        arguments: { account: "account-imap" },
      }),
    ) as { folders: Array<{ path: string; messageCount: number }> };
    assert.equal(folders.folders.length, 1);
    assert.equal(folders.folders[0].path, "INBOX");
    assert.equal(folders.folders[0].messageCount, 1);
  } finally {
    await connection.close();
    extension.stop();
    profile.cleanup();
  }
});

test("list_emails supports date windows and returns the salutation", async () => {
  const profile = makeTempProfile();
  const state = makeFakeState();
  const extension = startFakeExtension(profile.root, state);
  const connection = await connect(profile.root);
  try {
    const listed = payload(
      await connection.client.callTool({
        name: "list_emails",
        arguments: {
          folder: "Local Folders/Inbox",
          fromDate: "2024-01-02",
          toDate: "2024-01-02",
        },
      }),
    ) as {
      matched: number;
      fromDate: string;
      toDate: string;
      lastDate: string;
      messages: Array<{ subject: string; salutation?: string; snippet?: string }>;
    };
    assert.equal(listed.matched, 1);
    assert.equal(listed.messages.length, 1);
    assert.equal(listed.messages[0].subject, "Grüße aus München");
    assert.equal(listed.messages[0].salutation, "Hallo Bob,");
    assert.match(listed.messages[0].snippet ?? "", /Hallo Bob/);
    assert.equal(listed.fromDate, "2024-01-02");
    assert.equal(listed.toDate, "2024-01-02");
    assert.ok(listed.lastDate);
  } finally {
    await connection.close();
    extension.stop();
    profile.cleanup();
  }
});

