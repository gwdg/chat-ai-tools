import { chmodSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

export const SCHEMA_VERSION = 1;

const SCHEMA_SQL = `
CREATE TABLE companies (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  domain        TEXT,
  industry      TEXT,
  website       TEXT,
  owner         TEXT,
  custom_fields TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(custom_fields)),
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  archived_at   TEXT
) STRICT;

CREATE UNIQUE INDEX ux_companies_domain ON companies (lower(domain))
  WHERE domain IS NOT NULL AND archived_at IS NULL;

CREATE TABLE contacts (
  id            TEXT PRIMARY KEY,
  company_id    TEXT REFERENCES companies(id) ON DELETE SET NULL,
  first_name    TEXT NOT NULL,
  last_name     TEXT,
  email         TEXT,
  phone         TEXT,
  title         TEXT,
  owner         TEXT,
  source        TEXT,
  custom_fields TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(custom_fields)),
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  archived_at   TEXT
) STRICT;

CREATE UNIQUE INDEX ux_contacts_email ON contacts (lower(email))
  WHERE email IS NOT NULL AND archived_at IS NULL;
CREATE INDEX ix_contacts_company ON contacts (company_id);

CREATE TABLE deals (
  id                  TEXT PRIMARY KEY,
  name                TEXT NOT NULL,
  company_id          TEXT REFERENCES companies(id) ON DELETE SET NULL,
  primary_contact_id  TEXT REFERENCES contacts(id) ON DELETE SET NULL,
  amount_cents        INTEGER NOT NULL DEFAULT 0,
  currency            TEXT NOT NULL DEFAULT 'USD',
  stage               TEXT NOT NULL DEFAULT 'lead'
                      CHECK (stage IN ('lead','qualified','proposal','negotiation','won','lost')),
  probability         INTEGER CHECK (probability BETWEEN 0 AND 100),
  expected_close_date TEXT,
  owner               TEXT,
  created_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  closed_at           TEXT
) STRICT;

CREATE INDEX ix_deals_stage ON deals (stage);
CREATE INDEX ix_deals_company ON deals (company_id);

CREATE TABLE activities (
  id           TEXT PRIMARY KEY,
  type         TEXT NOT NULL CHECK (type IN ('note','call','email','meeting','task')),
  subject      TEXT,
  body         TEXT,
  contact_id   TEXT REFERENCES contacts(id) ON DELETE CASCADE,
  company_id   TEXT REFERENCES companies(id) ON DELETE CASCADE,
  deal_id      TEXT REFERENCES deals(id) ON DELETE CASCADE,
  occurred_at  TEXT,
  due_at       TEXT,
  completed_at TEXT,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
) STRICT;

CREATE INDEX ix_activities_contact ON activities (contact_id, occurred_at DESC);
CREATE INDEX ix_activities_company ON activities (company_id, occurred_at DESC);
CREATE INDEX ix_activities_deal ON activities (deal_id, occurred_at DESC);

CREATE TABLE tags (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL UNIQUE COLLATE NOCASE,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
) STRICT;

CREATE TABLE entity_tags (
  tag_id      TEXT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  entity_type TEXT NOT NULL CHECK (entity_type IN ('contact','company','deal')),
  entity_id   TEXT NOT NULL,
  PRIMARY KEY (tag_id, entity_type, entity_id)
) STRICT;

CREATE INDEX ix_entity_tags_entity ON entity_tags (entity_type, entity_id);

CREATE TABLE audit_log (
  id           TEXT PRIMARY KEY,
  ts           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  actor        TEXT NOT NULL,
  action       TEXT NOT NULL,
  entity_type  TEXT NOT NULL,
  entity_id    TEXT NOT NULL,
  confirmation TEXT NOT NULL,
  before_json  TEXT,
  after_json   TEXT
) STRICT;

CREATE INDEX ix_audit_entity ON audit_log (entity_type, entity_id, ts DESC);
CREATE INDEX ix_audit_action ON audit_log (action, ts DESC);

CREATE VIRTUAL TABLE crm_fts USING fts5(
  entity_type UNINDEXED,
  entity_id UNINDEXED,
  title,
  body
);

CREATE TRIGGER companies_fts_insert AFTER INSERT ON companies BEGIN
  INSERT INTO crm_fts(entity_type, entity_id, title, body)
  VALUES ('company', new.id, new.name, coalesce(new.domain,'') || ' ' || coalesce(new.industry,'') || ' ' || coalesce(new.website,'') || ' ' || coalesce(new.owner,''));
END;
CREATE TRIGGER companies_fts_update AFTER UPDATE ON companies BEGIN
  DELETE FROM crm_fts WHERE entity_type = 'company' AND entity_id = old.id;
  INSERT INTO crm_fts(entity_type, entity_id, title, body)
  VALUES ('company', new.id, new.name, coalesce(new.domain,'') || ' ' || coalesce(new.industry,'') || ' ' || coalesce(new.website,'') || ' ' || coalesce(new.owner,''));
END;
CREATE TRIGGER companies_fts_delete AFTER DELETE ON companies BEGIN
  DELETE FROM crm_fts WHERE entity_type = 'company' AND entity_id = old.id;
END;

CREATE TRIGGER contacts_fts_insert AFTER INSERT ON contacts BEGIN
  INSERT INTO crm_fts(entity_type, entity_id, title, body)
  VALUES ('contact', new.id, trim(new.first_name || ' ' || coalesce(new.last_name,'')), coalesce(new.email,'') || ' ' || coalesce(new.phone,'') || ' ' || coalesce(new.title,'') || ' ' || coalesce(new.owner,'') || ' ' || coalesce(new.source,''));
END;
CREATE TRIGGER contacts_fts_update AFTER UPDATE ON contacts BEGIN
  DELETE FROM crm_fts WHERE entity_type = 'contact' AND entity_id = old.id;
  INSERT INTO crm_fts(entity_type, entity_id, title, body)
  VALUES ('contact', new.id, trim(new.first_name || ' ' || coalesce(new.last_name,'')), coalesce(new.email,'') || ' ' || coalesce(new.phone,'') || ' ' || coalesce(new.title,'') || ' ' || coalesce(new.owner,'') || ' ' || coalesce(new.source,''));
END;
CREATE TRIGGER contacts_fts_delete AFTER DELETE ON contacts BEGIN
  DELETE FROM crm_fts WHERE entity_type = 'contact' AND entity_id = old.id;
END;

CREATE TRIGGER deals_fts_insert AFTER INSERT ON deals BEGIN
  INSERT INTO crm_fts(entity_type, entity_id, title, body)
  VALUES ('deal', new.id, new.name, new.stage || ' ' || new.currency || ' ' || coalesce(new.owner,''));
END;
CREATE TRIGGER deals_fts_update AFTER UPDATE ON deals BEGIN
  DELETE FROM crm_fts WHERE entity_type = 'deal' AND entity_id = old.id;
  INSERT INTO crm_fts(entity_type, entity_id, title, body)
  VALUES ('deal', new.id, new.name, new.stage || ' ' || new.currency || ' ' || coalesce(new.owner,''));
END;
CREATE TRIGGER deals_fts_delete AFTER DELETE ON deals BEGIN
  DELETE FROM crm_fts WHERE entity_type = 'deal' AND entity_id = old.id;
END;

CREATE TRIGGER activities_fts_insert AFTER INSERT ON activities BEGIN
  INSERT INTO crm_fts(entity_type, entity_id, title, body)
  VALUES ('activity', new.id, coalesce(new.subject,''), coalesce(new.body,''));
END;
CREATE TRIGGER activities_fts_update AFTER UPDATE ON activities BEGIN
  DELETE FROM crm_fts WHERE entity_type = 'activity' AND entity_id = old.id;
  INSERT INTO crm_fts(entity_type, entity_id, title, body)
  VALUES ('activity', new.id, coalesce(new.subject,''), coalesce(new.body,''));
END;
CREATE TRIGGER activities_fts_delete AFTER DELETE ON activities BEGIN
  DELETE FROM crm_fts WHERE entity_type = 'activity' AND entity_id = old.id;
END;
`;

function expandHome(value: string): string {
  if (value === "~") return process.env.HOME ?? value;
  if (value.startsWith("~/")) {
    return path.join(process.env.HOME ?? "~", value.slice(2));
  }
  return value;
}

export function resolveDatabasePath(value?: string): string {
  return expandHome(value || process.env.CRM_DB_PATH || "./crm.db");
}

export function openDatabase(databasePath = resolveDatabasePath()): DatabaseSync {
  const inMemory = databasePath === ":memory:";
  if (!inMemory) {
    const absolute = path.resolve(databasePath);
    const directory = path.dirname(absolute);
    if (!existsSync(directory)) {
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      try {
        chmodSync(directory, 0o700);
      } catch {
        // Ownership or filesystem restrictions may prevent chmod.
      }
    }
    databasePath = absolute;
  }

  const db = new DatabaseSync(databasePath);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = NORMAL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA busy_timeout = 5000");
  migrate(db);

  if (!inMemory) {
    try {
      chmodSync(path.resolve(databasePath), 0o600);
    } catch {
      // The database remains usable even if permissions cannot be tightened.
    }
  }

  return db;
}

function migrate(db: DatabaseSync): void {
  const row = db.prepare("PRAGMA user_version").get() as
    | { user_version?: number }
    | undefined;
  const version = Number(row?.user_version ?? 0);
  if (version > SCHEMA_VERSION) {
    throw new Error(
      `CRM database schema ${version} is newer than this server (${SCHEMA_VERSION}). Upgrade crm-mcp.`,
    );
  }
  if (version === SCHEMA_VERSION) return;

  db.exec("BEGIN IMMEDIATE");
  try {
    if (version < 1) db.exec(SCHEMA_SQL);
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function withTransaction<T>(db: DatabaseSync, action: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = action();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function closeDatabase(db: DatabaseSync): void {
  try {
    db.exec("PRAGMA optimize");
  } finally {
    db.close();
  }
}

export const SCHEMA_DOCUMENT = {
  version: SCHEMA_VERSION,
  entities: {
    companies: [
      "id",
      "name",
      "domain",
      "industry",
      "website",
      "owner",
      "custom_fields",
      "created_at",
      "updated_at",
      "archived_at",
    ],
    contacts: [
      "id",
      "company_id",
      "first_name",
      "last_name",
      "email",
      "phone",
      "title",
      "owner",
      "source",
      "custom_fields",
      "created_at",
      "updated_at",
      "archived_at",
    ],
    deals: [
      "id",
      "name",
      "company_id",
      "primary_contact_id",
      "amount_cents",
      "currency",
      "stage",
      "probability",
      "expected_close_date",
      "owner",
      "created_at",
      "updated_at",
      "closed_at",
    ],
    activities: [
      "id",
      "type",
      "subject",
      "body",
      "contact_id",
      "company_id",
      "deal_id",
      "occurred_at",
      "due_at",
      "completed_at",
      "created_at",
    ],
  },
  stages: ["lead", "qualified", "proposal", "negotiation", "won", "lost"],
  activity_types: ["note", "call", "email", "meeting", "task"],
  notes: [
    "All timestamps are UTC ISO-8601 text.",
    "Money is stored as integer amount_cents.",
    "Archived records are hidden from search unless requested.",
  ],
} as const;
