import assert from "node:assert/strict";
import test from "node:test";

import { openDatabase } from "../src/db.js";
import { CrmStore } from "../src/store.js";

function makeStore() {
  const db = openDatabase(":memory:");
  return { db, store: new CrmStore(db, "test") };
}

const meta = { actor: "test", confirmation: "once" } as const;

test("creates, searches, and deduplicates companies and contacts", () => {
  const { db, store } = makeStore();
  try {
    const company = store.createCompany(
      { name: "Acme", domain: "https://www.Acme.com/about", industry: "Software" },
      meta,
    );
    assert.equal(company.company.domain, "acme.com");

    assert.throws(
      () => store.createCompany({ name: "Acme again", domain: "acme.com" }, meta),
      /already exists/,
    );

    const contact = store.createContact(
      {
        first_name: "Ada",
        last_name: "Lovelace",
        email: "Ada@Acme.com",
        company_id: company.company.id,
      },
      meta,
    );
    assert.equal(contact.contact.email, "ada@acme.com");
    assert.equal(contact.company.name, "Acme");

    assert.throws(
      () =>
        store.createContact(
          { first_name: "Duplicate", email: "ada@acme.com" },
          meta,
        ),
      /already exists/,
    );

    const found = store.searchContacts({ query: "ada" });
    assert.equal(found.items.length, 1);
    assert.equal(found.items[0].company_name, "Acme");
    assert.equal(found.next_offset, null);

    assert.equal(store.searchCompanies({ query: "software" }).items.length, 1);
  } finally {
    db.close();
  }
});

test("moves deal stages, logs activity, completes tasks, and audits writes", () => {
  const { db, store } = makeStore();
  try {
    const company = store.createCompany({ name: "Globex" }, meta);
    const contact = store.createContact(
      { first_name: "Grace", company_id: company.company.id },
      meta,
    );
    const deal = store.createDeal(
      {
        name: "Renewal",
        company_id: company.company.id,
        primary_contact_id: contact.contact.id,
        amount_cents: 100_000,
        probability: 50,
      },
      meta,
    );
    assert.equal(deal.deal.stage, "lead");

    assert.throws(
      () => store.moveDealStage(deal.deal.id, "won", meta),
      /Cannot move deal/,
    );

    const qualified = store.moveDealStage(deal.deal.id, "qualified", meta);
    assert.equal(qualified.deal.stage, "qualified");
    assert.equal(qualified.activities.length, 1);
    assert.match(qualified.activities[0].subject, /Deal moved to qualified/);

    const task = store.createTask(
      {
        subject: "Send proposal",
        deal_id: deal.deal.id,
        contact_id: contact.contact.id,
      },
      meta,
    );
    assert.equal(task.type, "task");
    const completed = store.completeTask(task.id, meta);
    assert.ok(completed.completed_at);

    const activity = store.logActivity(
      {
        type: "note",
        subject: "Call summary",
        body: "Discussed renewal terms.",
        deal_id: deal.deal.id,
      },
      meta,
    );
    assert.equal(activity.subject, "Call summary");

    const summary = store.pipelineSummary();
    assert.equal(summary.stages[0].stage, "qualified");
    assert.equal(summary.stages[0].count, 1);
    assert.equal(summary.stages[0].weighted_cents, 50_000);

    const audit = store.listAuditLog({ entity_type: "deal" });
    assert.ok(audit.items.some((row) => row.action === "move_deal_stage"));
    assert.equal(audit.items[0].confirmation, "once");
    assert.ok(audit.items.every((row) => !("before_json" in row)));
  } finally {
    db.close();
  }
});

test("paginates searches and filters by tags", () => {
  const { db, store } = makeStore();
  try {
    for (const name of ["Alpha", "Beta", "Gamma"]) {
      store.createCompany({ name }, meta);
    }
    const first = store.searchCompanies({ limit: 2 });
    assert.equal(first.items.length, 2);
    assert.equal(first.next_offset, 2);

    const second = store.searchCompanies({ limit: 2, offset: 2 });
    assert.equal(second.items.length, 1);
    assert.equal(second.next_offset, null);

    const alpha = store.searchCompanies({ query: "Alpha" }).items[0];
    store.addTags("company", String(alpha.id), ["priority", "EMEA"], meta);
    const tagged = store.searchCompanies({ tag: "priority" });
    assert.equal(tagged.items.length, 1);
    assert.equal(tagged.items[0].name, "Alpha");

    store.removeTags("company", String(alpha.id), ["priority"], meta);
    assert.equal(store.searchCompanies({ tag: "priority" }).items.length, 0);
  } finally {
    db.close();
  }
});
