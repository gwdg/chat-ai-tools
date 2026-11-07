import type { DatabaseSync } from "node:sqlite";

import type { ConfirmationChoice } from "./dialog.js";
import { UserError } from "./errors.js";
import { uuidv7 } from "./ids.js";
import { withTransaction } from "./db.js";

export type EntityType = "contact" | "company" | "deal";
export type Stage =
  | "lead"
  | "qualified"
  | "proposal"
  | "negotiation"
  | "won"
  | "lost";
export type ActivityType = "note" | "call" | "email" | "meeting" | "task";
export type Confirmation = Exclude<ConfirmationChoice, "deny">;

export interface AuditMeta {
  actor: string;
  confirmation: Confirmation;
}

type Row = Record<string, any>;

export interface Page<T> {
  items: T[];
  next_offset: number | null;
}

const STAGES: Stage[] = [
  "lead",
  "qualified",
  "proposal",
  "negotiation",
  "won",
  "lost",
];

const STAGE_TRANSITIONS: Record<Stage, Stage[]> = {
  lead: ["qualified", "lost"],
  qualified: ["proposal", "lost"],
  proposal: ["negotiation", "won", "lost"],
  negotiation: ["won", "lost"],
  won: [],
  lost: ["lead"],
};

function required(value: string | undefined, field: string): string {
  const text = String(value ?? "").trim();
  if (!text) throw new UserError(`${field} is required.`);
  return text;
}

function clean(value: string | null | undefined): string | null {
  if (value === undefined || value === null) return null;
  const text = value.trim();
  return text || null;
}

function normalizeEmail(value: string | null | undefined): string | null {
  const email = clean(value);
  return email ? email.toLowerCase() : null;
}

function normalizeDomain(value: string | null | undefined): string | null {
  const text = clean(value);
  if (!text) return null;
  return (
    text
      .replace(/^https?:\/\//i, "")
      .replace(/^www\./i, "")
      .split(/[/:?#]/)[0]
      .toLowerCase() || null
  );
}

function normalizeCurrency(value: string | undefined): string {
  const currency = required(value ?? "USD", "currency").toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) {
    throw new UserError("currency must be a three-letter ISO code, for example USD.");
  }
  return currency;
}

function normalizeStage(value: string, field = "stage"): Stage {
  if (!STAGES.includes(value as Stage)) {
    throw new UserError(`${field} must be one of: ${STAGES.join(", ")}.`);
  }
  return value as Stage;
}

function normalizeTimestamp(
  value: string | null | undefined,
  field: string,
): string | null {
  const text = clean(value);
  if (!text) return null;
  const date = new Date(text);
  if (Number.isNaN(date.getTime())) {
    throw new UserError(`${field} must be a valid ISO-8601 date or timestamp.`);
  }
  return date.toISOString();
}

function normalizeCustomFields(
  value: Record<string, unknown> | null | undefined,
): string {
  if (value === undefined || value === null) return "{}";
  if (Array.isArray(value) || typeof value !== "object") {
    throw new UserError("custom_fields must be an object.");
  }
  return JSON.stringify(value);
}

function parseJson(value: unknown, fallback: unknown): unknown {
  if (value === null || value === undefined) return fallback;
  try {
    return JSON.parse(String(value));
  } catch {
    return fallback;
  }
}

function pageLimit(value: number | undefined): number {
  return Math.min(100, Math.max(1, Math.trunc(value ?? 20)));
}

function pageOffset(value: number | undefined): number {
  return Math.max(0, Math.trunc(value ?? 0));
}

function like(value: string): string {
  return `%${value.toLowerCase()}%`;
}

function assertFound(row: Row | undefined, label: string, id: string): Row {
  if (!row) {
    throw new UserError(
      `${label} not found: id=${id}. Use the corresponding search tool to find the right id.`,
    );
  }
  return row;
}

function assertEntityType(value: string): EntityType {
  if (value !== "contact" && value !== "company" && value !== "deal") {
    throw new UserError("entity_type must be contact, company, or deal.");
  }
  return value;
}

function activityView(row: Row): Row {
  return {
    ...row,
    contact_name: row.contact_name ?? null,
    company_name: row.company_name ?? null,
    deal_name: row.deal_name ?? null,
  };
}

export class CrmStore {
  constructor(
    private readonly db: DatabaseSync,
    private readonly defaultActor = process.env.CRM_ACTOR || "mcp-client",
  ) {}

  private all(sql: string, params: unknown[] = []): Row[] {
    return this.db.prepare(sql).all(...(params as any[])) as Row[];
  }

  private get(sql: string, params: unknown[] = []): Row | undefined {
    return this.db.prepare(sql).get(...(params as any[])) as Row | undefined;
  }

  private run(sql: string, params: unknown[] = []): void {
    this.db.prepare(sql).run(...(params as any[]));
  }

  private audit(
    meta: AuditMeta,
    action: string,
    entityType: string,
    entityId: string,
    before: unknown,
    after: unknown,
  ): void {
    this.run(
      `INSERT INTO audit_log
        (id, ts, actor, action, entity_type, entity_id, confirmation, before_json, after_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        uuidv7(),
        new Date().toISOString(),
        meta.actor || this.defaultActor,
        action,
        entityType,
        entityId,
        meta.confirmation,
        before === undefined ? null : JSON.stringify(before),
        after === undefined ? null : JSON.stringify(after),
      ],
    );
  }

  private page(sql: string, params: unknown[], limit?: number, offset?: number): Row[] {
    const size = pageLimit(limit);
    const start = pageOffset(offset);
    return this.all(sql, [...params, size + 1, start]);
  }

  private result(rows: Row[], limit?: number, offset?: number): { rows: Row[]; next: number | null } {
    const size = pageLimit(limit);
    const start = pageOffset(offset);
    return {
      rows: rows.slice(0, size),
      next: rows.length > size ? start + size : null,
    };
  }

  private companyRow(id: string, includeArchived = false): Row | undefined {
    return this.get(
      `SELECT * FROM companies WHERE id = ?${includeArchived ? "" : " AND archived_at IS NULL"}`,
      [id],
    );
  }

  private contactRow(id: string, includeArchived = false): Row | undefined {
    return this.get(
      `SELECT * FROM contacts WHERE id = ?${includeArchived ? "" : " AND archived_at IS NULL"}`,
      [id],
    );
  }

  private dealRow(id: string): Row | undefined {
    return this.get("SELECT * FROM deals WHERE id = ?", [id]);
  }

  private activityRow(id: string): Row | undefined {
    return this.get("SELECT * FROM activities WHERE id = ?", [id]);
  }

  private tagsFor(entityType: EntityType, entityId: string): string[] {
    return this.all(
      `SELECT t.name FROM tags t
        JOIN entity_tags et ON et.tag_id = t.id
       WHERE et.entity_type = ? AND et.entity_id = ?
       ORDER BY t.name COLLATE NOCASE`,
      [entityType, entityId],
    ).map((row) => String(row.name));
  }

  private assertCompany(id: string | null | undefined): void {
    if (!id) return;
    if (!this.companyRow(id)) {
      throw new UserError(
        `Company not found: id=${id}. Use search_companies to find the right id.`,
      );
    }
  }

  private assertContact(id: string | null | undefined): void {
    if (!id) return;
    if (!this.contactRow(id)) {
      throw new UserError(
        `Contact not found: id=${id}. Use search_contacts to find the right id.`,
      );
    }
  }

  private assertDeal(id: string | null | undefined): void {
    if (!id) return;
    if (!this.dealRow(id)) {
      throw new UserError(
        `Deal not found: id=${id}. Use search_deals to find the right id.`,
      );
    }
  }

  private contactView(row: Row): Row {
    return { ...row, custom_fields: parseJson(row.custom_fields, {}) };
  }

  private companyView(row: Row): Row {
    return { ...row, custom_fields: parseJson(row.custom_fields, {}) };
  }

  private recordTags(entityType: EntityType, entityId: string): void {
    if (entityType === "contact") this.assertContact(entityId);
    else if (entityType === "company") this.assertCompany(entityId);
    else this.assertDeal(entityId);
  }

  searchContacts(input: {
    query?: string;
    company_id?: string;
    tag?: string;
    limit?: number;
    offset?: number;
  }): Page<Row> {
    const where = ["c.archived_at IS NULL"];
    const params: unknown[] = [];
    const query = clean(input.query);
    if (query) {
      const needle = like(query);
      where.push(
        "(lower(c.first_name || ' ' || coalesce(c.last_name,'')) LIKE ? OR lower(coalesce(c.email,'')) LIKE ? OR lower(coalesce(co.name,'')) LIKE ?)",
      );
      params.push(needle, needle, needle);
    }
    if (input.company_id) {
      where.push("c.company_id = ?");
      params.push(input.company_id);
    }
    if (input.tag) {
      where.push(
        "EXISTS (SELECT 1 FROM entity_tags et JOIN tags t ON t.id = et.tag_id WHERE et.entity_type = 'contact' AND et.entity_id = c.id AND t.name = ? COLLATE NOCASE)",
      );
      params.push(input.tag);
    }
    const rows = this.page(
      `SELECT c.id, c.first_name, c.last_name, c.email, c.phone, c.title, c.owner,
              c.company_id, co.name AS company_name, c.updated_at
         FROM contacts c
         LEFT JOIN companies co ON co.id = c.company_id
        WHERE ${where.join(" AND ")}
        ORDER BY c.updated_at DESC, c.id DESC
        LIMIT ? OFFSET ?`,
      params,
      input.limit,
      input.offset,
    );
    const paged = this.result(rows, input.limit, input.offset);
    return { items: paged.rows, next_offset: paged.next };
  }

  getContact(id: string): Row {
    const contact = this.contactView(assertFound(this.contactRow(id), "Contact", id));
    const company = contact.company_id ? this.companyRow(String(contact.company_id)) : undefined;
    const deals = this.all(
      `SELECT * FROM deals
        WHERE (primary_contact_id = ? OR company_id = ?)
          AND stage NOT IN ('won','lost')
        ORDER BY updated_at DESC LIMIT 10`,
      [id, contact.company_id ?? null],
    );
    const activities = this.all(
      `SELECT a.*, c.first_name || ' ' || coalesce(c.last_name,'') AS contact_name,
              co.name AS company_name, d.name AS deal_name
         FROM activities a
         LEFT JOIN contacts c ON c.id = a.contact_id
         LEFT JOIN companies co ON co.id = a.company_id
         LEFT JOIN deals d ON d.id = a.deal_id
        WHERE a.contact_id = ?
        ORDER BY coalesce(a.occurred_at, a.created_at) DESC
        LIMIT 10`,
      [id],
    );
    return {
      contact,
      company: company ? this.companyView(company) : null,
      open_deals: deals,
      recent_activities: activities.map(activityView),
      tags: this.tagsFor("contact", id),
    };
  }

  searchCompanies(input: {
    query?: string;
    tag?: string;
    limit?: number;
    offset?: number;
  }): Page<Row> {
    const where = ["co.archived_at IS NULL"];
    const params: unknown[] = [];
    const query = clean(input.query);
    if (query) {
      const needle = like(query);
      where.push(
        "(lower(co.name) LIKE ? OR lower(coalesce(co.domain,'')) LIKE ? OR lower(coalesce(co.industry,'')) LIKE ?)",
      );
      params.push(needle, needle, needle);
    }
    if (input.tag) {
      where.push(
        "EXISTS (SELECT 1 FROM entity_tags et JOIN tags t ON t.id = et.tag_id WHERE et.entity_type = 'company' AND et.entity_id = co.id AND t.name = ? COLLATE NOCASE)",
      );
      params.push(input.tag);
    }
    const rows = this.page(
      `SELECT co.id, co.name, co.domain, co.industry, co.website, co.owner,
              co.updated_at,
              (SELECT COUNT(*) FROM contacts c WHERE c.company_id = co.id AND c.archived_at IS NULL) AS contact_count,
              (SELECT COUNT(*) FROM deals d WHERE d.company_id = co.id AND d.stage NOT IN ('won','lost')) AS open_deal_count
         FROM companies co
        WHERE ${where.join(" AND ")}
        ORDER BY co.updated_at DESC, co.id DESC
        LIMIT ? OFFSET ?`,
      params,
      input.limit,
      input.offset,
    );
    const paged = this.result(rows, input.limit, input.offset);
    return { items: paged.rows, next_offset: paged.next };
  }

  getCompany(id: string): Row {
    const company = this.companyView(assertFound(this.companyRow(id), "Company", id));
    const contacts = this.all(
      `SELECT id, first_name, last_name, email, phone, title, owner, updated_at
         FROM contacts WHERE company_id = ? AND archived_at IS NULL
        ORDER BY updated_at DESC LIMIT 100`,
      [id],
    );
    const deals = this.all(
      `SELECT * FROM deals WHERE company_id = ? AND stage NOT IN ('won','lost')
        ORDER BY updated_at DESC LIMIT 20`,
      [id],
    );
    const activities = this.all(
      `SELECT a.*, c.first_name || ' ' || coalesce(c.last_name,'') AS contact_name,
              co.name AS company_name, d.name AS deal_name
         FROM activities a
         LEFT JOIN contacts c ON c.id = a.contact_id
         LEFT JOIN companies co ON co.id = a.company_id
         LEFT JOIN deals d ON d.id = a.deal_id
        WHERE a.company_id = ?
        ORDER BY coalesce(a.occurred_at, a.created_at) DESC
        LIMIT 10`,
      [id],
    );
    return {
      company,
      contacts,
      open_deals: deals,
      recent_activities: activities.map(activityView),
      tags: this.tagsFor("company", id),
    };
  }

  searchDeals(input: {
    query?: string;
    stage?: string;
    owner?: string;
    company_id?: string;
    close_from?: string;
    close_to?: string;
    tag?: string;
    limit?: number;
    offset?: number;
  }): Page<Row> {
    const where = ["1 = 1"];
    const params: unknown[] = [];
    const query = clean(input.query);
    if (query) {
      const needle = like(query);
      where.push("(lower(d.name) LIKE ? OR lower(coalesce(d.owner,'')) LIKE ?)");
      params.push(needle, needle);
    }
    if (input.stage) {
      where.push("d.stage = ?");
      params.push(normalizeStage(input.stage));
    }
    if (input.owner) {
      where.push("lower(coalesce(d.owner,'')) = lower(?)");
      params.push(input.owner);
    }
    if (input.company_id) {
      where.push("d.company_id = ?");
      params.push(input.company_id);
    }
    const closeFrom = normalizeTimestamp(input.close_from, "close_from");
    const closeTo = normalizeTimestamp(input.close_to, "close_to");
    if (closeFrom) {
      where.push("d.expected_close_date >= ?");
      params.push(closeFrom);
    }
    if (closeTo) {
      where.push("d.expected_close_date <= ?");
      params.push(closeTo);
    }
    if (input.tag) {
      where.push(
        "EXISTS (SELECT 1 FROM entity_tags et JOIN tags t ON t.id = et.tag_id WHERE et.entity_type = 'deal' AND et.entity_id = d.id AND t.name = ? COLLATE NOCASE)",
      );
      params.push(input.tag);
    }
    const rows = this.page(
      `SELECT d.*, co.name AS company_name,
              trim(c.first_name || ' ' || coalesce(c.last_name,'')) AS primary_contact_name
         FROM deals d
         LEFT JOIN companies co ON co.id = d.company_id
         LEFT JOIN contacts c ON c.id = d.primary_contact_id
        WHERE ${where.join(" AND ")}
        ORDER BY d.updated_at DESC, d.id DESC
        LIMIT ? OFFSET ?`,
      params,
      input.limit,
      input.offset,
    );
    const paged = this.result(rows, input.limit, input.offset);
    return { items: paged.rows, next_offset: paged.next };
  }

  getDeal(id: string): Row {
    const deal = assertFound(this.dealRow(id), "Deal", id);
    const company = deal.company_id ? this.companyRow(String(deal.company_id)) : undefined;
    const contact = deal.primary_contact_id
      ? this.contactRow(String(deal.primary_contact_id), true)
      : undefined;
    const activities = this.all(
      `SELECT a.*, c.first_name || ' ' || coalesce(c.last_name,'') AS contact_name,
              co.name AS company_name, d.name AS deal_name
         FROM activities a
         LEFT JOIN contacts c ON c.id = a.contact_id
         LEFT JOIN companies co ON co.id = a.company_id
         LEFT JOIN deals d ON d.id = a.deal_id
        WHERE a.deal_id = ?
        ORDER BY coalesce(a.occurred_at, a.created_at) DESC
        LIMIT 20`,
      [id],
    );
    return {
      deal,
      company: company ? this.companyView(company) : null,
      primary_contact: contact ? this.contactView(contact) : null,
      activities: activities.map(activityView),
      tags: this.tagsFor("deal", id),
    };
  }

  listActivities(input: {
    contact_id?: string;
    company_id?: string;
    deal_id?: string;
    type?: string;
    from?: string;
    to?: string;
    include_completed?: boolean;
    limit?: number;
    offset?: number;
  }): Page<Row> {
    const where = ["1 = 1"];
    const params: unknown[] = [];
    if (input.contact_id) {
      where.push("a.contact_id = ?");
      params.push(input.contact_id);
    }
    if (input.company_id) {
      where.push("a.company_id = ?");
      params.push(input.company_id);
    }
    if (input.deal_id) {
      where.push("a.deal_id = ?");
      params.push(input.deal_id);
    }
    if (input.type) {
      if (!["note", "call", "email", "meeting", "task"].includes(input.type)) {
        throw new UserError("type must be note, call, email, meeting, or task.");
      }
      where.push("a.type = ?");
      params.push(input.type);
    }
    const from = normalizeTimestamp(input.from, "from");
    const to = normalizeTimestamp(input.to, "to");
    if (from) {
      where.push("coalesce(a.occurred_at, a.created_at) >= ?");
      params.push(from);
    }
    if (to) {
      where.push("coalesce(a.occurred_at, a.created_at) <= ?");
      params.push(to);
    }
    if (input.include_completed === false) {
      where.push("a.completed_at IS NULL");
    }
    const rows = this.page(
      `SELECT a.*, c.first_name || ' ' || coalesce(c.last_name,'') AS contact_name,
              co.name AS company_name, d.name AS deal_name
         FROM activities a
         LEFT JOIN contacts c ON c.id = a.contact_id
         LEFT JOIN companies co ON co.id = a.company_id
         LEFT JOIN deals d ON d.id = a.deal_id
        WHERE ${where.join(" AND ")}
        ORDER BY coalesce(a.occurred_at, a.created_at) DESC, a.created_at DESC
        LIMIT ? OFFSET ?`,
      params,
      input.limit,
      input.offset,
    );
    const paged = this.result(rows, input.limit, input.offset);
    return {
      items: paged.rows.map(activityView),
      next_offset: paged.next,
    };
  }

  createCompany(
    input: {
      name: string;
      domain?: string | null;
      industry?: string | null;
      website?: string | null;
      owner?: string | null;
      custom_fields?: Record<string, unknown> | null;
    },
    meta: AuditMeta,
  ): Row {
    return withTransaction(this.db, () => {
      const name = required(input.name, "name");
      const domain = normalizeDomain(input.domain);
      if (domain) {
        const duplicate = this.get(
          "SELECT id FROM companies WHERE lower(domain) = lower(?) AND archived_at IS NULL",
          [domain],
        );
        if (duplicate) {
          throw new UserError(
            `Company already exists: id=${duplicate.id}. Use get_company or update_company instead.`,
          );
        }
      }
      const id = uuidv7();
      this.run(
        `INSERT INTO companies
          (id, name, domain, industry, website, owner, custom_fields)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          id,
          name,
          domain,
          clean(input.industry),
          clean(input.website),
          clean(input.owner),
          normalizeCustomFields(input.custom_fields),
        ],
      );
      const after = this.companyRow(id, true);
      this.audit(meta, "create_company", "company", id, null, after);
      return this.getCompany(id);
    });
  }

  updateCompany(
    id: string,
    patch: {
      name?: string;
      domain?: string | null;
      industry?: string | null;
      website?: string | null;
      owner?: string | null;
      custom_fields?: Record<string, unknown> | null;
    },
    meta: AuditMeta,
  ): Row {
    return withTransaction(this.db, () => {
      const before = assertFound(this.companyRow(id), "Company", id);
      const updates: string[] = [];
      const params: unknown[] = [];
      if (patch.name !== undefined) {
        updates.push("name = ?");
        params.push(required(patch.name, "name"));
      }
      if (patch.domain !== undefined) {
        const domain = normalizeDomain(patch.domain);
        if (domain) {
          const duplicate = this.get(
            "SELECT id FROM companies WHERE lower(domain) = lower(?) AND archived_at IS NULL AND id <> ?",
            [domain, id],
          );
          if (duplicate) {
            throw new UserError(
              `Company domain already belongs to id=${duplicate.id}.`,
            );
          }
        }
        updates.push("domain = ?");
        params.push(domain);
      }
      if (patch.industry !== undefined) {
        updates.push("industry = ?");
        params.push(clean(patch.industry));
      }
      if (patch.website !== undefined) {
        updates.push("website = ?");
        params.push(clean(patch.website));
      }
      if (patch.owner !== undefined) {
        updates.push("owner = ?");
        params.push(clean(patch.owner));
      }
      if (patch.custom_fields !== undefined) {
        updates.push("custom_fields = ?");
        params.push(normalizeCustomFields(patch.custom_fields));
      }
      if (!updates.length) throw new UserError("No fields were provided to update.");
      updates.push("updated_at = ?");
      params.push(new Date().toISOString(), id);
      this.run(
        `UPDATE companies SET ${updates.join(", ")} WHERE id = ?`,
        params,
      );
      const after = this.companyRow(id, true);
      this.audit(meta, "update_company", "company", id, before, after);
      return this.getCompany(id);
    });
  }

  archiveCompany(id: string, meta: AuditMeta): Row {
    return withTransaction(this.db, () => {
      const before = assertFound(this.companyRow(id), "Company", id);
      const archivedAt = new Date().toISOString();
      this.run(
        "UPDATE companies SET archived_at = ?, updated_at = ? WHERE id = ?",
        [archivedAt, archivedAt, id],
      );
      const after = this.companyRow(id, true);
      this.audit(meta, "archive_company", "company", id, before, after);
      return after!;
    });
  }

  createContact(
    input: {
      first_name: string;
      last_name?: string | null;
      email?: string | null;
      phone?: string | null;
      title?: string | null;
      company_id?: string | null;
      owner?: string | null;
      source?: string | null;
      custom_fields?: Record<string, unknown> | null;
    },
    meta: AuditMeta,
  ): Row {
    return withTransaction(this.db, () => {
      const firstName = required(input.first_name, "first_name");
      const email = normalizeEmail(input.email);
      this.assertCompany(input.company_id);
      if (email) {
        const duplicate = this.get(
          "SELECT id FROM contacts WHERE lower(email) = lower(?) AND archived_at IS NULL",
          [email],
        );
        if (duplicate) {
          throw new UserError(
            `Contact already exists: id=${duplicate.id}. Use get_contact or update_contact instead.`,
          );
        }
      }
      const id = uuidv7();
      this.run(
        `INSERT INTO contacts
          (id, company_id, first_name, last_name, email, phone, title, owner, source, custom_fields)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          id,
          clean(input.company_id),
          firstName,
          clean(input.last_name),
          email,
          clean(input.phone),
          clean(input.title),
          clean(input.owner),
          clean(input.source),
          normalizeCustomFields(input.custom_fields),
        ],
      );
      const after = this.contactRow(id, true);
      this.audit(meta, "create_contact", "contact", id, null, after);
      return this.getContact(id);
    });
  }

  updateContact(
    id: string,
    patch: {
      first_name?: string;
      last_name?: string | null;
      email?: string | null;
      phone?: string | null;
      title?: string | null;
      company_id?: string | null;
      owner?: string | null;
      source?: string | null;
      custom_fields?: Record<string, unknown> | null;
    },
    meta: AuditMeta,
  ): Row {
    return withTransaction(this.db, () => {
      const before = assertFound(this.contactRow(id), "Contact", id);
      const updates: string[] = [];
      const params: unknown[] = [];
      if (patch.first_name !== undefined) {
        updates.push("first_name = ?");
        params.push(required(patch.first_name, "first_name"));
      }
      if (patch.last_name !== undefined) {
        updates.push("last_name = ?");
        params.push(clean(patch.last_name));
      }
      if (patch.email !== undefined) {
        const email = normalizeEmail(patch.email);
        if (email) {
          const duplicate = this.get(
            "SELECT id FROM contacts WHERE lower(email) = lower(?) AND archived_at IS NULL AND id <> ?",
            [email, id],
          );
          if (duplicate) {
            throw new UserError(`Contact email already belongs to id=${duplicate.id}.`);
          }
        }
        updates.push("email = ?");
        params.push(email);
      }
      if (patch.company_id !== undefined) {
        this.assertCompany(patch.company_id);
        updates.push("company_id = ?");
        params.push(clean(patch.company_id));
      }
      if (patch.phone !== undefined) {
        updates.push("phone = ?");
        params.push(clean(patch.phone));
      }
      if (patch.title !== undefined) {
        updates.push("title = ?");
        params.push(clean(patch.title));
      }
      if (patch.owner !== undefined) {
        updates.push("owner = ?");
        params.push(clean(patch.owner));
      }
      if (patch.source !== undefined) {
        updates.push("source = ?");
        params.push(clean(patch.source));
      }
      if (patch.custom_fields !== undefined) {
        updates.push("custom_fields = ?");
        params.push(normalizeCustomFields(patch.custom_fields));
      }
      if (!updates.length) throw new UserError("No fields were provided to update.");
      updates.push("updated_at = ?");
      params.push(new Date().toISOString(), id);
      this.run(
        `UPDATE contacts SET ${updates.join(", ")} WHERE id = ?`,
        params,
      );
      const after = this.contactRow(id, true);
      this.audit(meta, "update_contact", "contact", id, before, after);
      return this.getContact(id);
    });
  }

  archiveContact(id: string, meta: AuditMeta): Row {
    return withTransaction(this.db, () => {
      const before = assertFound(this.contactRow(id), "Contact", id);
      const archivedAt = new Date().toISOString();
      this.run(
        "UPDATE contacts SET archived_at = ?, updated_at = ? WHERE id = ?",
        [archivedAt, archivedAt, id],
      );
      const after = this.contactRow(id, true);
      this.audit(meta, "archive_contact", "contact", id, before, after);
      return after!;
    });
  }

  createDeal(
    input: {
      name: string;
      company_id?: string | null;
      primary_contact_id?: string | null;
      amount_cents?: number;
      currency?: string;
      stage?: string;
      probability?: number | null;
      expected_close_date?: string | null;
      owner?: string | null;
    },
    meta: AuditMeta,
  ): Row {
    return withTransaction(this.db, () => {
      const name = required(input.name, "name");
      const companyId = clean(input.company_id);
      const contactId = clean(input.primary_contact_id);
      this.assertCompany(companyId);
      this.assertContact(contactId);
      const amount = Math.max(0, Math.trunc(input.amount_cents ?? 0));
      const probability =
        input.probability === undefined || input.probability === null
          ? null
          : Math.min(100, Math.max(0, Math.trunc(input.probability)));
      const stage = input.stage ? normalizeStage(input.stage) : "lead";
      const closedAt =
        stage === "won" || stage === "lost" ? new Date().toISOString() : null;
      const id = uuidv7();
      this.run(
        `INSERT INTO deals
          (id, name, company_id, primary_contact_id, amount_cents, currency, stage,
           probability, expected_close_date, owner, closed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          id,
          name,
          companyId,
          contactId,
          amount,
          normalizeCurrency(input.currency),
          stage,
          probability,
          normalizeTimestamp(input.expected_close_date, "expected_close_date"),
          clean(input.owner),
          closedAt,
        ],
      );
      const after = this.dealRow(id);
      this.audit(meta, "create_deal", "deal", id, null, after);
      return this.getDeal(id);
    });
  }

  updateDeal(
    id: string,
    patch: {
      name?: string;
      company_id?: string | null;
      primary_contact_id?: string | null;
      amount_cents?: number;
      currency?: string;
      probability?: number | null;
      expected_close_date?: string | null;
      owner?: string | null;
    },
    meta: AuditMeta,
  ): Row {
    return withTransaction(this.db, () => {
      const before = assertFound(this.dealRow(id), "Deal", id);
      const updates: string[] = [];
      const params: unknown[] = [];
      if (patch.name !== undefined) {
        updates.push("name = ?");
        params.push(required(patch.name, "name"));
      }
      if (patch.company_id !== undefined) {
        this.assertCompany(patch.company_id);
        updates.push("company_id = ?");
        params.push(clean(patch.company_id));
      }
      if (patch.primary_contact_id !== undefined) {
        this.assertContact(patch.primary_contact_id);
        updates.push("primary_contact_id = ?");
        params.push(clean(patch.primary_contact_id));
      }
      if (patch.amount_cents !== undefined) {
        updates.push("amount_cents = ?");
        params.push(Math.max(0, Math.trunc(patch.amount_cents)));
      }
      if (patch.currency !== undefined) {
        updates.push("currency = ?");
        params.push(normalizeCurrency(patch.currency));
      }
      if (patch.probability !== undefined) {
        updates.push("probability = ?");
        params.push(
          patch.probability === null
            ? null
            : Math.min(100, Math.max(0, Math.trunc(patch.probability))),
        );
      }
      if (patch.expected_close_date !== undefined) {
        updates.push("expected_close_date = ?");
        params.push(normalizeTimestamp(patch.expected_close_date, "expected_close_date"));
      }
      if (patch.owner !== undefined) {
        updates.push("owner = ?");
        params.push(clean(patch.owner));
      }
      if (!updates.length) throw new UserError("No fields were provided to update.");
      updates.push("updated_at = ?");
      params.push(new Date().toISOString(), id);
      this.run(`UPDATE deals SET ${updates.join(", ")} WHERE id = ?`, params);
      const after = this.dealRow(id);
      this.audit(meta, "update_deal", "deal", id, before, after);
      return this.getDeal(id);
    });
  }

  moveDealStage(id: string, nextStage: string, meta: AuditMeta): Row {
    return withTransaction(this.db, () => {
      const before = assertFound(this.dealRow(id), "Deal", id);
      const stage = normalizeStage(nextStage);
      const current = before.stage as Stage;
      if (current === stage) {
        throw new UserError(`Deal ${id} is already in stage ${stage}.`);
      }
      if (!STAGE_TRANSITIONS[current]?.includes(stage)) {
        throw new UserError(
          `Cannot move deal from ${current} to ${stage}. Allowed: ${
            STAGE_TRANSITIONS[current]?.join(", ") || "(none)"
          }.`,
        );
      }
      const now = new Date().toISOString();
      const closedAt = stage === "won" || stage === "lost" ? now : null;
      this.run(
        "UPDATE deals SET stage = ?, closed_at = ?, updated_at = ? WHERE id = ?",
        [stage, closedAt, now, id],
      );
      const activityId = uuidv7();
      this.run(
        `INSERT INTO activities
          (id, type, subject, body, contact_id, company_id, deal_id, occurred_at)
         VALUES (?, 'note', ?, ?, ?, ?, ?, ?)`,
        [
          activityId,
          `Deal moved to ${stage}`,
          `${before.name}: ${current} -> ${stage}`,
          before.primary_contact_id ?? null,
          before.company_id ?? null,
          id,
          now,
        ],
      );
      const after = this.dealRow(id);
      this.audit(meta, "move_deal_stage", "deal", id, before, after);
      return this.getDeal(id);
    });
  }

  logActivity(
    input: {
      type: string;
      subject?: string | null;
      body?: string | null;
      contact_id?: string | null;
      company_id?: string | null;
      deal_id?: string | null;
      occurred_at?: string | null;
    },
    meta: AuditMeta,
  ): Row {
    return withTransaction(this.db, () => {
      if (!["note", "call", "email", "meeting"].includes(input.type)) {
        throw new UserError("type must be note, call, email, or meeting.");
      }
      const contactId = clean(input.contact_id);
      const companyId = clean(input.company_id);
      const dealId = clean(input.deal_id);
      if (!contactId && !companyId && !dealId) {
        throw new UserError("Provide contact_id, company_id, or deal_id.");
      }
      this.assertContact(contactId);
      this.assertCompany(companyId);
      this.assertDeal(dealId);
      const id = uuidv7();
      const occurredAt =
        normalizeTimestamp(input.occurred_at, "occurred_at") ??
        new Date().toISOString();
      this.run(
        `INSERT INTO activities
          (id, type, subject, body, contact_id, company_id, deal_id, occurred_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          id,
          input.type,
          clean(input.subject),
          clean(input.body),
          contactId,
          companyId,
          dealId,
          occurredAt,
        ],
      );
      const after = this.activityRow(id);
      this.audit(meta, "log_activity", "activity", id, null, after);
      return this.getActivity(id);
    });
  }

  createTask(
    input: {
      subject: string;
      body?: string | null;
      due_at?: string | null;
      contact_id?: string | null;
      company_id?: string | null;
      deal_id?: string | null;
    },
    meta: AuditMeta,
  ): Row {
    return withTransaction(this.db, () => {
      const subject = required(input.subject, "subject");
      const contactId = clean(input.contact_id);
      const companyId = clean(input.company_id);
      const dealId = clean(input.deal_id);
      this.assertContact(contactId);
      this.assertCompany(companyId);
      this.assertDeal(dealId);
      const id = uuidv7();
      this.run(
        `INSERT INTO activities
          (id, type, subject, body, contact_id, company_id, deal_id, due_at)
         VALUES (?, 'task', ?, ?, ?, ?, ?, ?)`,
        [
          id,
          subject,
          clean(input.body),
          contactId,
          companyId,
          dealId,
          normalizeTimestamp(input.due_at, "due_at"),
        ],
      );
      const after = this.activityRow(id);
      this.audit(meta, "create_task", "activity", id, null, after);
      return this.getActivity(id);
    });
  }

  completeTask(id: string, meta: AuditMeta): Row {
    return withTransaction(this.db, () => {
      const before = assertFound(this.activityRow(id), "Task", id);
      if (before.type !== "task") {
        throw new UserError(`Activity ${id} is not a task (type=${before.type}).`);
      }
      if (before.completed_at) {
        throw new UserError(`Task ${id} is already completed.`);
      }
      const completedAt = new Date().toISOString();
      this.run("UPDATE activities SET completed_at = ? WHERE id = ?", [
        completedAt,
        id,
      ]);
      const after = this.activityRow(id);
      this.audit(meta, "complete_task", "activity", id, before, after);
      return this.getActivity(id);
    });
  }

  getActivity(id: string): Row {
    const row = assertFound(
      this.get(
        `SELECT a.*, c.first_name || ' ' || coalesce(c.last_name,'') AS contact_name,
                co.name AS company_name, d.name AS deal_name
           FROM activities a
           LEFT JOIN contacts c ON c.id = a.contact_id
           LEFT JOIN companies co ON co.id = a.company_id
           LEFT JOIN deals d ON d.id = a.deal_id
          WHERE a.id = ?`,
        [id],
      ),
      "Activity",
      id,
    );
    return activityView(row);
  }

  pipelineSummary(owner?: string): Row {
    const params: unknown[] = [];
    let filter = "";
    if (owner) {
      filter = "WHERE lower(coalesce(owner,'')) = lower(?)";
      params.push(owner);
    }
    const rows = this.all(
      `SELECT stage, currency, COUNT(*) AS count,
              COALESCE(SUM(amount_cents), 0) AS total_cents,
              COALESCE(SUM(CAST(amount_cents * COALESCE(probability, 0) / 100.0 AS INTEGER)), 0) AS weighted_cents
         FROM deals
         ${filter}
        GROUP BY stage, currency
        ORDER BY stage, currency`,
      params,
    );
    const currencies = this.all(
      `SELECT currency, COUNT(*) AS count,
              COALESCE(SUM(amount_cents), 0) AS total_cents,
              COALESCE(SUM(CAST(amount_cents * COALESCE(probability, 0) / 100.0 AS INTEGER)), 0) AS weighted_cents
         FROM deals
         ${filter}
        GROUP BY currency
        ORDER BY currency`,
      params,
    );
    return { stages: rows, totals_by_currency: currencies };
  }

  addTags(
    entityType: string,
    entityId: string,
    tags: string[],
    meta: AuditMeta,
  ): Row {
    return withTransaction(this.db, () => {
      const type = assertEntityType(entityType);
      this.recordTags(type, entityId);
      const before = this.tagsFor(type, entityId);
      const names = [...new Set(tags.map((tag) => tag.trim()).filter(Boolean))];
      if (!names.length) throw new UserError("At least one tag is required.");
      for (const name of names) {
        this.run(
          "INSERT INTO tags (id, name) VALUES (?, ?) ON CONFLICT(name) DO NOTHING",
          [uuidv7(), name],
        );
        const tag = this.get("SELECT id FROM tags WHERE name = ? COLLATE NOCASE", [
          name,
        ]);
        if (!tag) throw new UserError(`Could not create tag "${name}".`);
        this.run(
          "INSERT OR IGNORE INTO entity_tags (tag_id, entity_type, entity_id) VALUES (?, ?, ?)",
          [tag.id, type, entityId],
        );
      }
      const after = this.tagsFor(type, entityId);
      this.audit(meta, "add_tags", type, entityId, { tags: before }, { tags: after });
      return { entity_type: type, entity_id: entityId, tags: after };
    });
  }

  removeTags(
    entityType: string,
    entityId: string,
    tags: string[],
    meta: AuditMeta,
  ): Row {
    return withTransaction(this.db, () => {
      const type = assertEntityType(entityType);
      this.recordTags(type, entityId);
      const before = this.tagsFor(type, entityId);
      const names = [...new Set(tags.map((tag) => tag.trim()).filter(Boolean))];
      if (!names.length) throw new UserError("At least one tag is required.");
      for (const name of names) {
        this.run(
          `DELETE FROM entity_tags
            WHERE entity_type = ? AND entity_id = ?
              AND tag_id IN (SELECT id FROM tags WHERE name = ? COLLATE NOCASE)`,
          [type, entityId, name],
        );
      }
      const after = this.tagsFor(type, entityId);
      this.audit(meta, "remove_tags", type, entityId, { tags: before }, { tags: after });
      return { entity_type: type, entity_id: entityId, tags: after };
    });
  }

  listAuditLog(input: {
    entity_type?: string;
    entity_id?: string;
    action?: string;
    limit?: number;
    offset?: number;
  }): Page<Row> {
    const where = ["1 = 1"];
    const params: unknown[] = [];
    if (input.entity_type) {
      where.push("entity_type = ?");
      params.push(input.entity_type);
    }
    if (input.entity_id) {
      where.push("entity_id = ?");
      params.push(input.entity_id);
    }
    if (input.action) {
      where.push("action = ?");
      params.push(input.action);
    }
    const rows = this.page(
      `SELECT * FROM audit_log WHERE ${where.join(" AND ")}
        ORDER BY ts DESC, id DESC LIMIT ? OFFSET ?`,
      params,
      input.limit,
      input.offset,
    );
    const paged = this.result(rows, input.limit, input.offset);
    return {
      items: paged.rows.map((row) => {
        const { before_json, after_json, ...rest } = row;
        return {
          ...rest,
          before: parseJson(before_json, null),
          after: parseJson(after_json, null),
        };
      }),
      next_offset: paged.next,
    };
  }
}
