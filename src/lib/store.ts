import type { Database } from "bun:sqlite";
import { redactAgent, redactCompany, redactGeneric, redactIssue, redactProject } from "./redact.ts";

type Rec = Record<string, unknown>;
const s = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : v == null ? null : String(v));
const iso = (v: unknown): string | null => {
  if (v == null) return null;
  if (typeof v === "string") return v;
  if (v instanceof Date) return v.toISOString();
  return null;
};

export function upsertCompany(db: Database, company: Rec, apiBase: string, syncedAt: string): void {
  const r = redactCompany(company);
  db.query(`
    INSERT INTO companies (id, name, issue_prefix, status, api_base, updated_at, synced_at, raw_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      name=excluded.name, issue_prefix=excluded.issue_prefix, status=excluded.status, api_base=excluded.api_base,
      updated_at=excluded.updated_at, synced_at=excluded.synced_at, raw_json=excluded.raw_json
  `).run(
    String(r.id), String(r.name ?? ""), s(r.issuePrefix), s(r.status), apiBase, iso(r.updatedAt), syncedAt, JSON.stringify(r),
  );
}

export function upsertIssue(db: Database, issue: Rec, syncedAt: string): void {
  const r = redactIssue(issue);
  db.query(`
    INSERT INTO issues (id, company_id, identifier, project_id, goal_id, parent_id, status, priority, title, description,
                        assignee_agent_id, assignee_user_id, created_at, updated_at, completed_at, synced_at, raw_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      company_id=excluded.company_id, identifier=excluded.identifier, project_id=excluded.project_id, goal_id=excluded.goal_id,
      parent_id=excluded.parent_id, status=excluded.status, priority=excluded.priority, title=excluded.title,
      description=excluded.description, assignee_agent_id=excluded.assignee_agent_id, assignee_user_id=excluded.assignee_user_id,
      created_at=excluded.created_at, updated_at=excluded.updated_at, completed_at=excluded.completed_at,
      synced_at=excluded.synced_at, raw_json=excluded.raw_json
  `).run(
    String(r.id), String(r.companyId), s(r.identifier), s(r.projectId), s(r.goalId), s(r.parentId),
    String(r.status ?? "unknown"), s(r.priority), String(r.title ?? ""), s(r.description),
    s(r.assigneeAgentId), s(r.assigneeUserId), iso(r.createdAt), iso(r.updatedAt), iso(r.completedAt), syncedAt, JSON.stringify(r),
  );
}

export function upsertComment(db: Database, comment: Rec, syncedAt: string): void {
  const r = redactGeneric(comment) as Rec;
  db.query(`
    INSERT INTO comments (id, issue_id, company_id, author_type, author_agent_id, author_user_id, body, created_at, updated_at, synced_at, raw_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      issue_id=excluded.issue_id, company_id=excluded.company_id, author_type=excluded.author_type,
      author_agent_id=excluded.author_agent_id, author_user_id=excluded.author_user_id, body=excluded.body,
      created_at=excluded.created_at, updated_at=excluded.updated_at, synced_at=excluded.synced_at, raw_json=excluded.raw_json
  `).run(
    String(r.id), String(r.issueId), String(r.companyId), s(r.authorType), s(r.authorAgentId), s(r.authorUserId),
    String(r.body ?? ""), iso(r.createdAt), iso(r.updatedAt), syncedAt, JSON.stringify(r),
  );
}

export function markCommentsSynced(db: Database, issueId: string, at: string): void {
  db.query("UPDATE issues SET comments_synced_at=? WHERE id=?").run(at, issueId);
}

export function deleteCommentsNotSyncedSince(db: Database, issueId: string, since: string): number {
  // Count first: bun:sqlite's `.changes` is total_changes-like and includes FTS trigger writes.
  const n = db.query<{ n: number }, [string, string]>("SELECT count(*) AS n FROM comments WHERE issue_id=? AND synced_at < ?").get(issueId, since)?.n ?? 0;
  if (n > 0) db.query("DELETE FROM comments WHERE issue_id=? AND synced_at < ?").run(issueId, since);
  return n;
}

export function upsertApproval(db: Database, approval: Rec, syncedAt: string): void {
  const r = redactGeneric(approval) as Rec;
  db.query(`
    INSERT INTO approvals (id, company_id, type, status, requested_by_agent_id, created_at, updated_at, synced_at, raw_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      company_id=excluded.company_id, type=excluded.type, status=excluded.status, requested_by_agent_id=excluded.requested_by_agent_id,
      created_at=excluded.created_at, updated_at=excluded.updated_at, synced_at=excluded.synced_at, raw_json=excluded.raw_json
  `).run(
    String(r.id), String(r.companyId), s(r.type), s(r.status), s(r.requestedByAgentId), iso(r.createdAt), iso(r.updatedAt), syncedAt, JSON.stringify(r),
  );
}

export function upsertAgent(db: Database, agent: Rec, syncedAt: string): void {
  const r = redactAgent(agent);
  db.query(`
    INSERT INTO agents (id, company_id, name, url_key, role, title, status, reports_to, updated_at, synced_at, raw_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      company_id=excluded.company_id, name=excluded.name, url_key=excluded.url_key, role=excluded.role, title=excluded.title,
      status=excluded.status, reports_to=excluded.reports_to, updated_at=excluded.updated_at, synced_at=excluded.synced_at, raw_json=excluded.raw_json
  `).run(
    String(r.id), String(r.companyId), String(r.name ?? ""), s(r.urlKey), s(r.role), s(r.title), s(r.status), s(r.reportsTo),
    iso(r.updatedAt), syncedAt, JSON.stringify(r),
  );
}

export function upsertProject(db: Database, project: Rec, syncedAt: string): void {
  const r = redactProject(project);
  db.query(`
    INSERT INTO projects (id, company_id, name, url_key, status, lead_agent_id, updated_at, synced_at, raw_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      company_id=excluded.company_id, name=excluded.name, url_key=excluded.url_key, status=excluded.status,
      lead_agent_id=excluded.lead_agent_id, updated_at=excluded.updated_at, synced_at=excluded.synced_at, raw_json=excluded.raw_json
  `).run(
    String(r.id), String(r.companyId), String(r.name ?? ""), s(r.urlKey), s(r.status), s(r.leadAgentId), iso(r.updatedAt), syncedAt, JSON.stringify(r),
  );
}

/** Remove rows for a company that a full listing did not touch (upstream deleted/hidden). */
export function pruneNotSyncedSince(db: Database, table: "issues" | "approvals" | "agents" | "projects", companyId: string, since: string): number {
  const changes = db.query<{ n: number }, [string, string]>(`SELECT count(*) AS n FROM ${table} WHERE company_id=? AND synced_at < ?`).get(companyId, since)?.n ?? 0;
  if (changes > 0) db.query(`DELETE FROM ${table} WHERE company_id=? AND synced_at < ?`).run(companyId, since);
  if (table === "issues" && changes > 0) {
    db.query("DELETE FROM comments WHERE company_id=? AND issue_id NOT IN (SELECT id FROM issues WHERE company_id=?)").run(companyId, companyId);
  }
  return changes;
}

export interface SyncStateRow {
  profile: string;
  company_id: string;
  entity: string;
  cursor: string | null;
  last_sync_at: string | null;
  last_full_at: string | null;
  last_status: string | null;
  last_error: string | null;
  last_count: number | null;
}

export function getSyncState(db: Database, profile: string, companyId: string, entity: string): SyncStateRow | null {
  return db.query<SyncStateRow, [string, string, string]>(
    "SELECT * FROM sync_state WHERE profile=? AND company_id=? AND entity=?",
  ).get(profile, companyId, entity);
}

export function putSyncState(db: Database, row: Partial<SyncStateRow> & Pick<SyncStateRow, "profile" | "company_id" | "entity">): void {
  const prev = getSyncState(db, row.profile, row.company_id, row.entity);
  const merged: SyncStateRow = {
    profile: row.profile,
    company_id: row.company_id,
    entity: row.entity,
    cursor: row.cursor !== undefined ? row.cursor : prev?.cursor ?? null,
    last_sync_at: row.last_sync_at !== undefined ? row.last_sync_at : prev?.last_sync_at ?? null,
    last_full_at: row.last_full_at !== undefined ? row.last_full_at : prev?.last_full_at ?? null,
    last_status: row.last_status !== undefined ? row.last_status : prev?.last_status ?? null,
    last_error: row.last_error !== undefined ? row.last_error : prev?.last_error ?? null,
    last_count: row.last_count !== undefined ? row.last_count : prev?.last_count ?? null,
  };
  db.query(`
    INSERT INTO sync_state (profile, company_id, entity, cursor, last_sync_at, last_full_at, last_status, last_error, last_count)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(profile, company_id, entity) DO UPDATE SET
      cursor=excluded.cursor, last_sync_at=excluded.last_sync_at, last_full_at=excluded.last_full_at,
      last_status=excluded.last_status, last_error=excluded.last_error, last_count=excluded.last_count
  `).run(
    merged.profile, merged.company_id, merged.entity, merged.cursor, merged.last_sync_at, merged.last_full_at,
    merged.last_status, merged.last_error, merged.last_count,
  );
}

export function allSyncState(db: Database): SyncStateRow[] {
  return db.query<SyncStateRow, []>("SELECT * FROM sync_state ORDER BY profile, company_id, entity").all();
}

export function lastSyncAt(db: Database): string | null {
  const row = db.query<{ v: string | null }, []>("SELECT max(last_sync_at) AS v FROM sync_state WHERE last_status='ok'").get();
  return row?.v ?? null;
}
