import type { Database } from "bun:sqlite";

export interface IssueRow {
  id: string;
  company_id: string;
  identifier: string | null;
  project_id: string | null;
  status: string;
  priority: string | null;
  title: string;
  description: string | null;
  assignee_agent_id: string | null;
  assignee_name?: string | null;
  created_at: string | null;
  updated_at: string | null;
  synced_at: string;
  comments_synced_at: string | null;
}

export interface IssueListFilter {
  companyId?: string | null;
  status?: string[];
  assigneeAgentId?: string;
  projectId?: string;
  match?: string;
  limit?: number;
}

const ISSUE_COLS = `i.id, i.company_id, i.identifier, i.project_id, i.status, i.priority, i.title, i.description,
  i.assignee_agent_id, a.name AS assignee_name, i.created_at, i.updated_at, i.synced_at, i.comments_synced_at`;

export function listIssues(db: Database, f: IssueListFilter = {}): IssueRow[] {
  const where: string[] = [];
  const args: (string | number)[] = [];
  if (f.companyId) { where.push("i.company_id = ?"); args.push(f.companyId); }
  if (f.status && f.status.length > 0) { where.push(`i.status IN (${f.status.map(() => "?").join(",")})`); args.push(...f.status); }
  if (f.assigneeAgentId) { where.push("i.assignee_agent_id = ?"); args.push(f.assigneeAgentId); }
  if (f.projectId) { where.push("i.project_id = ?"); args.push(f.projectId); }
  if (f.match) {
    const like = `%${f.match.toLowerCase()}%`;
    where.push("(lower(coalesce(i.identifier,'')) LIKE ? OR lower(i.title) LIKE ? OR lower(coalesce(i.description,'')) LIKE ?)");
    args.push(like, like, like);
  }
  const sql = `SELECT ${ISSUE_COLS} FROM issues i LEFT JOIN agents a ON a.id = i.assignee_agent_id
    ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
    ORDER BY i.updated_at DESC
    ${f.limit ? `LIMIT ${Math.max(1, Math.floor(f.limit))}` : ""}`;
  return db.query<IssueRow, (string | number)[]>(sql).all(...args);
}

export interface IssueDetail {
  row: IssueRow;
  raw: Record<string, unknown>;
  comments: Array<{ id: string; author_type: string | null; author_agent_id: string | null; author_name: string | null; author_user_id: string | null; body: string; created_at: string | null }>;
}

/** Look up by UUID or identifier (case-insensitive, e.g. ccs-12). */
export function getIssue(db: Database, idOrIdentifier: string, companyId?: string | null): IssueDetail | null {
  const key = idOrIdentifier.trim();
  const args: string[] = [key, key.toUpperCase()];
  let sql = `SELECT ${ISSUE_COLS}, i.raw_json FROM issues i LEFT JOIN agents a ON a.id = i.assignee_agent_id
    WHERE (i.id = ? OR upper(i.identifier) = ?)`;
  if (companyId) { sql += " AND i.company_id = ?"; args.push(companyId); }
  sql += " LIMIT 1";
  const row = db.query<IssueRow & { raw_json: string }, string[]>(sql).get(...args);
  if (!row) return null;
  const { raw_json, ...rest } = row;
  const comments = db.query<IssueDetail["comments"][number], [string]>(`
    SELECT c.id, c.author_type, c.author_agent_id, ag.name AS author_name, c.author_user_id, c.body, c.created_at
    FROM comments c LEFT JOIN agents ag ON ag.id = c.author_agent_id
    WHERE c.issue_id = ? ORDER BY c.created_at ASC
  `).all(rest.id);
  return { row: rest, raw: JSON.parse(raw_json) as Record<string, unknown>, comments };
}

export interface SearchHit {
  kind: "issue" | "comment";
  issue_id: string;
  identifier: string | null;
  company_id: string;
  status: string;
  title: string;
  updated_at: string | null;
  snippet: string;
  rank: number;
  comment_id?: string;
}

/**
 * Build a safe FTS5 query. Each whitespace token becomes a quoted phrase with a
 * prefix wildcard so "CCS-12", "ledger", or "sync lock" all behave intuitively.
 * A query wrapped in double quotes is passed through as one phrase.
 */
export function toFtsQuery(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) return '""';
  if (/^".*"$/.test(trimmed)) return trimmed.replace(/"/g, '""').replace(/^""|""$/g, '"');
  return trimmed
    .split(/\s+/)
    .map((tok) => tok.replace(/"/g, ""))
    .filter(Boolean)
    .map((tok) => `"${tok}"*`)
    .join(" ");
}

export interface SearchFilter {
  companyId?: string | null;
  status?: string[];
  limit?: number;
  includeComments?: boolean;
}

export function search(db: Database, query: string, f: SearchFilter = {}): SearchHit[] {
  const fts = toFtsQuery(query);
  const limit = Math.max(1, Math.floor(f.limit ?? 25));
  const where: string[] = [];
  const args: (string | number)[] = [];
  if (f.companyId) { where.push("i.company_id = ?"); args.push(f.companyId); }
  if (f.status && f.status.length > 0) { where.push(`i.status IN (${f.status.map(() => "?").join(",")})`); args.push(...f.status); }
  const extra = where.length ? ` AND ${where.join(" AND ")}` : "";

  const issueHits = db.query<SearchHit, (string | number)[]>(`
    SELECT 'issue' AS kind, i.id AS issue_id, i.identifier, i.company_id, i.status, i.title, i.updated_at,
           snippet(issues_fts, 2, '[', ']', '…', 18) AS snippet, bm25(issues_fts, 5.0, 3.0, 1.0) AS rank
    FROM issues_fts JOIN issues i ON i.rowid = issues_fts.rowid
    WHERE issues_fts MATCH ?${extra}
    ORDER BY rank LIMIT ?
  `).all(fts, ...args, limit);

  if (!f.includeComments) return issueHits;

  const commentHits = db.query<SearchHit, (string | number)[]>(`
    SELECT 'comment' AS kind, i.id AS issue_id, i.identifier, i.company_id, i.status, i.title, c.created_at AS updated_at,
           snippet(comments_fts, 0, '[', ']', '…', 18) AS snippet, bm25(comments_fts) AS rank, c.id AS comment_id
    FROM comments_fts JOIN comments c ON c.rowid = comments_fts.rowid JOIN issues i ON i.id = c.issue_id
    WHERE comments_fts MATCH ?${extra}
    ORDER BY rank LIMIT ?
  `).all(fts, ...args, limit);

  return [...issueHits, ...commentHits].sort((a, b) => a.rank - b.rank).slice(0, limit);
}

export function companiesSummary(db: Database): Array<{ id: string; name: string; issue_prefix: string | null; issues: number; open_issues: number; last_sync_at: string | null }> {
  return db.query<{ id: string; name: string; issue_prefix: string | null; issues: number; open_issues: number; last_sync_at: string | null }, []>(`
    SELECT c.id, c.name, c.issue_prefix,
      (SELECT count(*) FROM issues i WHERE i.company_id = c.id) AS issues,
      (SELECT count(*) FROM issues i WHERE i.company_id = c.id AND i.status IN ('todo','in_progress','in_review','blocked')) AS open_issues,
      (SELECT max(last_sync_at) FROM sync_state s WHERE s.company_id = c.id AND s.entity='issues' AND s.last_status='ok') AS last_sync_at
    FROM companies c ORDER BY c.name
  `).all();
}
