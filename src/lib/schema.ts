/**
 * SQLite schema for the paperclipcrawl mirror.
 *
 * Design rules:
 *  - Every entity row carries company_id so one DB serves every profile.
 *  - raw_json holds the (redacted) upstream payload; typed columns are for indexes/filters.
 *  - No secrets: redaction happens before insert (see redact.ts) and doctor re-verifies.
 *  - FTS5 external-content tables over issues/comments, kept in step by triggers.
 */
export const SCHEMA_VERSION = 1;

export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS companies (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  issue_prefix  TEXT,
  status        TEXT,
  api_base      TEXT NOT NULL,
  updated_at    TEXT,
  synced_at     TEXT NOT NULL,
  raw_json      TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS issues (
  id                 TEXT PRIMARY KEY,
  company_id         TEXT NOT NULL,
  identifier         TEXT,
  project_id         TEXT,
  goal_id            TEXT,
  parent_id          TEXT,
  status             TEXT NOT NULL,
  priority           TEXT,
  title              TEXT NOT NULL,
  description        TEXT,
  assignee_agent_id  TEXT,
  assignee_user_id   TEXT,
  created_at         TEXT,
  updated_at         TEXT,
  completed_at       TEXT,
  synced_at          TEXT NOT NULL,
  comments_synced_at TEXT,
  raw_json           TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_issues_company_status  ON issues(company_id, status);
CREATE INDEX IF NOT EXISTS idx_issues_company_updated ON issues(company_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_issues_identifier      ON issues(identifier);
CREATE INDEX IF NOT EXISTS idx_issues_assignee        ON issues(company_id, assignee_agent_id);
CREATE INDEX IF NOT EXISTS idx_issues_project         ON issues(company_id, project_id);

CREATE TABLE IF NOT EXISTS comments (
  id               TEXT PRIMARY KEY,
  issue_id         TEXT NOT NULL,
  company_id       TEXT NOT NULL,
  author_type      TEXT,
  author_agent_id  TEXT,
  author_user_id   TEXT,
  body             TEXT NOT NULL,
  created_at       TEXT,
  updated_at       TEXT,
  synced_at        TEXT NOT NULL,
  raw_json         TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_comments_issue ON comments(issue_id, created_at);

CREATE TABLE IF NOT EXISTS approvals (
  id                     TEXT PRIMARY KEY,
  company_id             TEXT NOT NULL,
  type                   TEXT,
  status                 TEXT,
  requested_by_agent_id  TEXT,
  created_at             TEXT,
  updated_at             TEXT,
  synced_at              TEXT NOT NULL,
  raw_json               TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_approvals_company_status ON approvals(company_id, status);

CREATE TABLE IF NOT EXISTS agents (
  id          TEXT PRIMARY KEY,
  company_id  TEXT NOT NULL,
  name        TEXT NOT NULL,
  url_key     TEXT,
  role        TEXT,
  title       TEXT,
  status      TEXT,
  reports_to  TEXT,
  updated_at  TEXT,
  synced_at   TEXT NOT NULL,
  raw_json    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_agents_company ON agents(company_id, name);

CREATE TABLE IF NOT EXISTS projects (
  id             TEXT PRIMARY KEY,
  company_id     TEXT NOT NULL,
  name           TEXT NOT NULL,
  url_key        TEXT,
  status         TEXT,
  lead_agent_id  TEXT,
  updated_at     TEXT,
  synced_at      TEXT NOT NULL,
  raw_json       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_projects_company ON projects(company_id, name);

CREATE TABLE IF NOT EXISTS sync_state (
  profile        TEXT NOT NULL,
  company_id     TEXT NOT NULL,
  entity         TEXT NOT NULL,
  cursor         TEXT,
  last_sync_at   TEXT,
  last_full_at   TEXT,
  last_status    TEXT,
  last_error     TEXT,
  last_count     INTEGER,
  PRIMARY KEY (profile, company_id, entity)
);

CREATE TABLE IF NOT EXISTS sync_runs (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at   TEXT NOT NULL,
  finished_at  TEXT,
  mode         TEXT NOT NULL,
  profiles     TEXT NOT NULL,
  status       TEXT,
  summary_json TEXT
);

-- FTS5 (external content) over issues.
CREATE VIRTUAL TABLE IF NOT EXISTS issues_fts USING fts5(
  identifier, title, description,
  content='issues', content_rowid='rowid',
  tokenize='unicode61 remove_diacritics 2'
);
CREATE TRIGGER IF NOT EXISTS issues_ai AFTER INSERT ON issues BEGIN
  INSERT INTO issues_fts(rowid, identifier, title, description)
    VALUES (new.rowid, new.identifier, new.title, new.description);
END;
CREATE TRIGGER IF NOT EXISTS issues_ad AFTER DELETE ON issues BEGIN
  INSERT INTO issues_fts(issues_fts, rowid, identifier, title, description)
    VALUES ('delete', old.rowid, old.identifier, old.title, old.description);
END;
CREATE TRIGGER IF NOT EXISTS issues_au AFTER UPDATE ON issues BEGIN
  INSERT INTO issues_fts(issues_fts, rowid, identifier, title, description)
    VALUES ('delete', old.rowid, old.identifier, old.title, old.description);
  INSERT INTO issues_fts(rowid, identifier, title, description)
    VALUES (new.rowid, new.identifier, new.title, new.description);
END;

-- FTS5 (external content) over comments.
CREATE VIRTUAL TABLE IF NOT EXISTS comments_fts USING fts5(
  body,
  content='comments', content_rowid='rowid',
  tokenize='unicode61 remove_diacritics 2'
);
CREATE TRIGGER IF NOT EXISTS comments_ai AFTER INSERT ON comments BEGIN
  INSERT INTO comments_fts(rowid, body) VALUES (new.rowid, new.body);
END;
CREATE TRIGGER IF NOT EXISTS comments_ad AFTER DELETE ON comments BEGIN
  INSERT INTO comments_fts(comments_fts, rowid, body) VALUES ('delete', old.rowid, old.body);
END;
CREATE TRIGGER IF NOT EXISTS comments_au AFTER UPDATE ON comments BEGIN
  INSERT INTO comments_fts(comments_fts, rowid, body) VALUES ('delete', old.rowid, old.body);
  INSERT INTO comments_fts(rowid, body) VALUES (new.rowid, new.body);
END;
`;

export const ENTITY_TABLES = ["companies", "issues", "comments", "approvals", "agents", "projects"] as const;
export type EntityTable = (typeof ENTITY_TABLES)[number];
