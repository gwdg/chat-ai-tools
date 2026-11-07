import assert from "node:assert/strict";
import test from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { openDatabase } from "../src/db.js";
import type { ConfirmationRequest } from "../src/dialog.js";
import { createServer } from "../src/server.js";
import { CrmStore } from "../src/store.js";

interface TestConnection {
  client: Client;
  server: McpServer;
  close: () => Promise<void>;
}

async function connect(
  store: CrmStore,
  confirmAction = async () => "session" as const,
): Promise<TestConnection> {
  const server = createServer({ store, confirmAction, actor: "test" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "crm-mcp-tests", version: "0.1.0" });
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

function payload(result: Awaited<ReturnType<Client["callTool"]>>): any {
  assert.equal(result.isError, undefined);
  const content = result.content as Array<{ type: string; text?: string }>;
  const text = content.find((item) => item.type === "text")?.text;
  assert.ok(text);
  return JSON.parse(text);
}

test("exposes CRM tools, resources, and prompts", async () => {
  const db = openDatabase(":memory:");
  const store = new CrmStore(db, "test");
  const connection = await connect(store);
  try {
    const tools = await connection.client.listTools();
    const names = tools.tools.map((tool) => tool.name).sort();
    assert.deepEqual(names, [
      "add_tags",
      "archive_company",
      "archive_contact",
      "complete_task",
      "create_company",
      "create_contact",
      "create_deal",
      "create_task",
      "get_company",
      "get_contact",
      "get_deal",
      "list_activities",
      "list_audit_log",
      "list_session_approvals",
      "log_activity",
      "move_deal_stage",
      "pipeline_summary",
      "remove_tags",
      "search_companies",
      "search_contacts",
      "search_deals",
      "update_company",
      "update_contact",
      "update_deal",
    ]);

    const schema = await connection.client.readResource({ uri: "crm://schema" });
    assert.match(schema.contents[0].text ?? "", /companies/);

    const company = payload(
      await connection.client.callTool({
        name: "create_company",
        arguments: { name: "Acme" },
      }),
    );
    const contact = payload(
      await connection.client.callTool({
        name: "create_contact",
        arguments: {
          first_name: "Ada",
          company_id: company.company.id,
        },
      }),
    );
    const contactResource = await connection.client.readResource({
      uri: `crm://contacts/${contact.contact.id}`,
    });
    assert.match(contactResource.contents[0].text ?? "", /Ada/);

    const prompts = await connection.client.listPrompts();
    assert.ok(prompts.prompts.some((prompt) => prompt.name === "account_brief"));
    const brief = await connection.client.getPrompt({
      name: "account_brief",
      arguments: { company_id: company.company.id },
    });
    assert.match(brief.messages[0].content.type === "text" ? brief.messages[0].content.text : "", /Acme/);
  } finally {
    await connection.close();
    db.close();
  }
});

test("confirms writes, reuses session approval, and saves the audit log", async () => {
  const db = openDatabase(":memory:");
  const store = new CrmStore(db, "test");
  const prompts: ConfirmationRequest[] = [];
  const connection = await connect(store, async (request) => {
    prompts.push(request);
    return prompts.length === 1 ? "deny" : "session";
  });
  try {
    const denied = await connection.client.callTool({
      name: "create_contact",
      arguments: { first_name: "Denied", email: "denied@example.com" },
    });
    assert.equal(denied.isError, true);
    assert.equal(prompts.length, 1);
    assert.equal(prompts[0].action, "create a contact");
    assert.match(prompts[0].details, /email: denied@example.com/);

    const created = payload(
      await connection.client.callTool({
        name: "create_contact",
        arguments: { first_name: "Ada", email: "ada@example.com" },
      }),
    );
    assert.equal(created.contact.first_name, "Ada");
    assert.equal(prompts.length, 2);

    const second = payload(
      await connection.client.callTool({
        name: "create_contact",
        arguments: { first_name: "Grace", email: "grace@example.com" },
      }),
    );
    assert.equal(second.contact.first_name, "Grace");
    assert.equal(prompts.length, 2);

    const readable = payload(
      await connection.client.callTool({
        name: "search_contacts",
        arguments: { query: "ada" },
      }),
    );
    assert.equal(readable.contacts.length, 1);
    assert.equal(prompts.length, 2);

    const audit = payload(
      await connection.client.callTool({
        name: "list_audit_log",
        arguments: { action: "create_contact" },
      }),
    );
    assert.ok(audit.items.length >= 2);
    assert.equal(audit.items[0].confirmation, "session");
    assert.equal(audit.items[0].actor, "test");
    assert.equal(audit.items[0].after.email, "grace@example.com");
  } finally {
    await connection.close();
    db.close();
  }
});

test("denied writes leave the database and audit log unchanged", async () => {
  const db = openDatabase(":memory:");
  const store = new CrmStore(db, "test");
  const connection = await connect(store, async () => "deny");
  try {
    const result = await connection.client.callTool({
      name: "create_company",
      arguments: { name: "Blocked" },
    });
    assert.equal(result.isError, true);
    assert.equal(store.searchCompanies({}).items.length, 0);
    assert.equal(store.listAuditLog({}).items.length, 0);
  } finally {
    await connection.close();
    db.close();
  }
});
