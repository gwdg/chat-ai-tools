import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { openDatabase } from "../src/db.js";
import type { ConfirmationRequest } from "../src/dialog.js";
import { createServer, type ServerOptions } from "../src/server.js";
import { CrmStore } from "../src/store.js";

interface TestConnection {
  client: Client;
  server: McpServer;
  close: () => Promise<void>;
}

async function connect(
  store: CrmStore,
  confirmAction = async () => "session" as const,
  serverOptions: Partial<ServerOptions> = {},
): Promise<TestConnection> {
  const server = createServer({
    ...serverOptions,
    store,
    confirmAction,
    actor: "test",
  });
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
      "generate_timeline_html",
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

test("generates and saves HTML timeline reports", async () => {
  const db = openDatabase(":memory:");
  const store = new CrmStore(db, "test");
  const directory = mkdtempSync(path.join(tmpdir(), "crm-report-"));
  const reportDir = path.join(directory, "reports");
  const connection = await connect(store, undefined, { reportDir });
  try {
    const company = payload(
      await connection.client.callTool({
        name: "create_company",
        arguments: { name: "Acme", domain: "acme.test" },
      }),
    );
    const contact = payload(
      await connection.client.callTool({
        name: "create_contact",
        arguments: {
          first_name: "Ada",
          last_name: "Lovelace",
          email: "ada@example.com",
          company_id: company.company.id,
        },
      }),
    );
    const deal = payload(
      await connection.client.callTool({
        name: "create_deal",
        arguments: {
          name: "Renewal",
          company_id: company.company.id,
          primary_contact_id: contact.contact.id,
          amount_cents: 1234500,
          currency: "EUR",
          stage: "proposal",
        },
      }),
    );

    await connection.client.callTool({
      name: "log_activity",
      arguments: {
        type: "email",
        subject: "Kickoff",
        body: "Hello <script>alert(1)</script>\nSecond line",
        contact_id: contact.contact.id,
        company_id: company.company.id,
        deal_id: deal.deal.id,
        occurred_at: "2026-01-02T10:00:00Z",
      },
    });
    await connection.client.callTool({
      name: "log_activity",
      arguments: {
        type: "call",
        subject: "Follow-up",
        body: "Discussed terms",
        deal_id: deal.deal.id,
        occurred_at: "2026-01-03T11:00:00Z",
      },
    });

    const report = payload(
      await connection.client.callTool({
        name: "generate_timeline_html",
        arguments: { entity_type: "deal", entity_id: deal.deal.id },
      }),
    );
    assert.equal(report.activity_count, 2);
    assert.equal(report.saved, true);
    assert.equal(report.filename, "timeline-deal-renewal.html");
    assert.equal(report.saved_path, undefined);
    assert.equal(report.html, undefined);
    assert.ok(!JSON.stringify(report).includes(directory));

    const reportPath = path.join(reportDir, report.filename);
    const reportHtml = readFileSync(reportPath, "utf8");
    assert.match(reportHtml, /Renewal/);
    assert.match(reportHtml, /Kickoff/);
    assert.match(reportHtml, /Discussed terms/);
    assert.match(reportHtml, /Second line/);
    assert.doesNotMatch(reportHtml, /<script>alert/);
    assert.match(reportHtml, /&lt;script&gt;alert/);

    const output = path.join(directory, "deal-report.html");
    const saved = payload(
      await connection.client.callTool({
        name: "generate_timeline_html",
        arguments: {
          entity_type: "deal",
          entity_id: deal.deal.id,
          output_path: output,
        },
      }),
    );
    assert.equal(saved.filename, "deal-report.html");
    assert.equal(saved.saved_path, undefined);
    assert.equal(saved.used_default_dir, false);
    assert.ok(saved.bytes > 1000);
    assert.match(readFileSync(output, "utf8"), /Discussed terms/);

    const audit = payload(
      await connection.client.callTool({
        name: "list_audit_log",
        arguments: { action: "generate_timeline_html" },
      }),
    );
    assert.equal(audit.items.length, 2);
    assert.ok(
      audit.items.every((item: any) => item.entity_id === deal.deal.id),
    );
    assert.deepEqual(
      audit.items.map((item: any) => item.after.filename).sort(),
      ["deal-report.html", "timeline-deal-renewal.html"],
    );
    assert.ok(
      audit.items.every((item: any) => !JSON.stringify(item).includes(directory)),
    );

    const companyReport = payload(
      await connection.client.callTool({
        name: "generate_timeline_html",
        arguments: { entity_type: "company", entity_id: company.company.id },
      }),
    );
    assert.match(
      readFileSync(path.join(reportDir, companyReport.filename), "utf8"),
      /Acme/,
    );

    const contactReport = payload(
      await connection.client.callTool({
        name: "generate_timeline_html",
        arguments: { entity_type: "contact", entity_id: contact.contact.id },
      }),
    );
    const contactHtml = readFileSync(
      path.join(reportDir, contactReport.filename),
      "utf8",
    );
    assert.match(contactHtml, /Ada/);
    assert.match(contactHtml, /Lovelace/);
  } finally {
    await connection.close();
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("writes reports to the configured default directory", async () => {
  const db = openDatabase(":memory:");
  const store = new CrmStore(db, "test");
  const directory = mkdtempSync(path.join(tmpdir(), "crm-report-dir-"));
  const reportDir = path.join(directory, "nested", "reports");
  const connection = await connect(store, undefined, { reportDir });
  try {
    const company = payload(
      await connection.client.callTool({
        name: "create_company",
        arguments: { name: "Default Dir Co" },
      }),
    );

    const report = payload(
      await connection.client.callTool({
        name: "generate_timeline_html",
        arguments: {
          entity_type: "company",
          entity_id: company.company.id,
        },
      }),
    );
    assert.equal(report.used_default_dir, true);
    assert.equal(report.filename, "timeline-company-default-dir-co.html");
    assert.equal(report.saved_path, undefined);
    assert.equal(report.html, undefined);
    assert.match(
      readFileSync(path.join(reportDir, report.filename), "utf8"),
      /Default Dir Co/,
    );

    const explicit = path.join(directory, "explicit.html");
    const overridden = payload(
      await connection.client.callTool({
        name: "generate_timeline_html",
        arguments: {
          entity_type: "company",
          entity_id: company.company.id,
          output_path: explicit,
        },
      }),
    );
    assert.equal(overridden.filename, "explicit.html");
    assert.equal(overridden.saved_path, undefined);
    assert.equal(overridden.used_default_dir, false);
    assert.ok(readFileSync(explicit, "utf8").includes("Default Dir Co"));

    const missing = path.join(directory, "missing", "report.html");
    const failed = await connection.client.callTool({
      name: "generate_timeline_html",
      arguments: {
        entity_type: "company",
        entity_id: company.company.id,
        output_path: missing,
      },
    });
    assert.equal(failed.isError, true);
    const failureText = (failed.content as Array<{ type: string; text?: string }>)
      .map((item) => item.text ?? "")
      .join("\n");
    assert.match(failureText, /report directory does not exist/i);
    assert.ok(!failureText.includes(directory));
  } finally {
    await connection.close();
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
