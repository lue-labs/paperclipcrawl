import type { Database } from "bun:sqlite";
import { apiPath, ApiRequestError, describeApiError, type PaperclipReader } from "./api.ts";
import type { ResolvedTarget } from "./context.ts";
import {
  deleteCommentsNotSyncedSince, getSyncState, markCommentsSynced, pruneNotSyncedSince, putSyncState, syncStamp,
  upsertAgent, upsertApproval, upsertComment, upsertCompany, upsertIssue, upsertProject,
} from "./store.ts";

type Rec = Record<string, unknown>;

/** Server contract (server/src/routes/issues.ts): limit ≤ 1000, offset, sortField=updated, sortDir. */
export const ISSUE_PAGE = 500;
/** Server contract: comments limit ≤ 500, afterCommentId, order asc|desc. */
export const COMMENT_PAGE = 500;
/** Open statuses whose comment threads may move without bumping issue.updatedAt. */
export const ACTIVE_STATUSES = new Set(["todo", "in_progress", "in_review", "blocked"]);

export interface SyncOptions {
  /** Ignore cursors; list everything and prune rows upstream no longer returns. */
  full?: boolean;
  /** Only pull issues updated at/after this ISO time (overrides cursor). */
  since?: string;
  /** none: skip comment hydration. changed: changed + active issues (default). all: every issue. */
  comments?: "none" | "changed" | "all";
  /** Max concurrent comment fetches. */
  concurrency?: number;
  log?: (line: string) => void;
}

export interface EntityResult {
  entity: string;
  count: number;
  pruned?: number;
  status: "ok" | "error" | "skipped";
  error?: string;
}

export interface CompanySyncResult {
  profile: string;
  companyId: string;
  apiBase: string;
  startedAt: string;
  finishedAt: string;
  mode: "full" | "incremental";
  entities: EntityResult[];
  issuesChanged: number;
  commentsHydrated: number;
  status: "ok" | "partial" | "error";
}

function nowIso(): string {
  return new Date().toISOString();
}

/** Write stamp within a run: wall clock, but never below `startedAt` so this run's rows always survive its own prune. */
function runStamp(startedAt: string): string {
  const now = nowIso();
  return now > startedAt ? now : startedAt;
}

function asArray<T = Rec>(v: unknown): T[] {
  if (Array.isArray(v)) return v as T[];
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    for (const k of ["issues", "items", "data", "rows", "results"]) {
      if (Array.isArray(o[k])) return o[k] as T[];
    }
  }
  return [];
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i] as T);
    }
  });
  await Promise.all(workers);
  return out;
}

/** Fetch every page of issues, newest-updated first; stop once a page's oldest item predates `since`. */
export async function fetchIssues(api: PaperclipReader, companyId: string, since: string | null, log?: (l: string) => void): Promise<Rec[]> {
  const out: Rec[] = [];
  const sinceMs = since ? Date.parse(since) : NaN;
  let offset = 0;
  for (;;) {
    const params = new URLSearchParams({ limit: String(ISSUE_PAGE), offset: String(offset), sortField: "updated", sortDir: "desc" });
    const page = asArray(await api.get(`${apiPath`/api/companies/${companyId}/issues`}?${params.toString()}`));
    out.push(...page);
    log?.(`  issues page offset=${offset} got=${page.length}`);
    if (page.length < ISSUE_PAGE) break;
    if (Number.isFinite(sinceMs)) {
      const last = page[page.length - 1];
      const lastUpdated = Date.parse(String(last?.updatedAt ?? ""));
      if (Number.isFinite(lastUpdated) && lastUpdated < sinceMs) break;
    }
    offset += ISSUE_PAGE;
  }
  if (Number.isFinite(sinceMs)) {
    return out.filter((i) => {
      const t = Date.parse(String(i.updatedAt ?? ""));
      return !Number.isFinite(t) || t >= sinceMs;
    });
  }
  return out;
}

export async function fetchAllComments(api: PaperclipReader, issueId: string): Promise<Rec[]> {
  const out: Rec[] = [];
  let after: string | undefined;
  for (;;) {
    const params = new URLSearchParams({ limit: String(COMMENT_PAGE), order: "asc" });
    if (after) params.set("afterCommentId", after);
    const page = asArray(await api.get(`${apiPath`/api/issues/${issueId}/comments`}?${params.toString()}`));
    out.push(...page);
    if (page.length < COMMENT_PAGE) break;
    after = String(page[page.length - 1]?.id ?? "");
    if (!after) break;
  }
  return out;
}

async function fetchCompany(api: PaperclipReader, companyId: string): Promise<Rec | null> {
  try {
    return (await api.get<Rec>(apiPath`/api/companies/${companyId}`)) ?? null;
  } catch (err) {
    if (err instanceof ApiRequestError && err.status === 403) {
      // Some agent tokens cannot read the company record itself; fall back to the list.
      const list = asArray(await api.get("/api/companies"));
      return list.find((c) => c.id === companyId) ?? null;
    }
    throw err;
  }
}

/** Hydrate comments for a set of issue ids; replaces each issue's thread atomically. */
export async function hydrateComments(db: Database, api: PaperclipReader, issueIds: string[], concurrency: number, log?: (l: string) => void): Promise<{ hydrated: number; failed: number }> {
  let hydrated = 0;
  let failed = 0;
  await mapLimit(issueIds, concurrency, async (issueId) => {
    try {
      const comments = await fetchAllComments(api, issueId);
      const at = syncStamp(db); // strictly after any existing stamp, so the replace below cannot miss same-ms rows
      db.transaction(() => {
        for (const c of comments) upsertComment(db, c, at);
        deleteCommentsNotSyncedSince(db, issueId, at);
        markCommentsSynced(db, issueId, at);
      })();
      hydrated += 1;
    } catch (err) {
      failed += 1;
      log?.(`  comments ${issueId}: ${describeApiError(err)}`);
    }
  });
  return { hydrated, failed };
}

export async function syncCompany(db: Database, api: PaperclipReader, target: ResolvedTarget, opts: SyncOptions = {}): Promise<CompanySyncResult> {
  const { profileName: profile, apiBase } = target;
  if (!target.companyId) throw new Error(`Profile '${profile}' has no companyId.`);
  const companyId: string = target.companyId;
  const log = opts.log ?? (() => {});
  const startedAt = syncStamp(db); // prune predicates are `synced_at < startedAt`; must be strictly after the previous run
  const entities: EntityResult[] = [];
  const commentsMode = opts.comments ?? "changed";
  const concurrency = opts.concurrency ?? 4;

  const issueState = getSyncState(db, profile, companyId, "issues");
  const mode: "full" | "incremental" = opts.full || !issueState?.cursor ? "full" : "incremental";
  const since = opts.since ?? (mode === "incremental" ? issueState?.cursor ?? null : null);

  log(`[${profile}] company=${companyId} mode=${mode}${since ? ` since=${since}` : ""}`);

  // Company record.
  try {
    const company = await fetchCompany(api, companyId);
    if (company) upsertCompany(db, company, apiBase, startedAt);
    entities.push({ entity: "companies", count: company ? 1 : 0, status: "ok" });
    putSyncState(db, { profile, company_id: companyId, entity: "companies", last_sync_at: startedAt, last_status: "ok", last_error: null, last_count: company ? 1 : 0 });
  } catch (err) {
    const msg = describeApiError(err);
    entities.push({ entity: "companies", count: 0, status: "error", error: msg });
    putSyncState(db, { profile, company_id: companyId, entity: "companies", last_status: "error", last_error: msg });
    // If we cannot even read the company, the rest will fail identically; bail early with what we have.
    return finish("error", 0, 0);
  }

  // Directory tables: always a full list (small), prune stale.
  const directory: Array<{ entity: "agents" | "projects" | "approvals"; path: string; upsert: (r: Rec) => void }> = [
    { entity: "agents", path: apiPath`/api/companies/${companyId}/agents`, upsert: (r) => upsertAgent(db, r, startedAt) },
    { entity: "projects", path: apiPath`/api/companies/${companyId}/projects`, upsert: (r) => upsertProject(db, r, startedAt) },
    { entity: "approvals", path: apiPath`/api/companies/${companyId}/approvals`, upsert: (r) => upsertApproval(db, r, startedAt) },
  ];
  for (const d of directory) {
    try {
      const rows = asArray(await api.get(d.path));
      const at = runStamp(startedAt);
      db.transaction(() => {
        for (const r of rows) d.upsert(r);
      })();
      const pruned = pruneNotSyncedSince(db, d.entity, companyId, startedAt);
      entities.push({ entity: d.entity, count: rows.length, pruned, status: "ok" });
      putSyncState(db, { profile, company_id: companyId, entity: d.entity, last_sync_at: at, last_full_at: at, last_status: "ok", last_error: null, last_count: rows.length });
      log(`  ${d.entity}: ${rows.length}${pruned ? ` (pruned ${pruned})` : ""}`);
    } catch (err) {
      const msg = describeApiError(err);
      entities.push({ entity: d.entity, count: 0, status: "error", error: msg });
      putSyncState(db, { profile, company_id: companyId, entity: d.entity, last_status: "error", last_error: msg });
      log(`  ${d.entity}: ERROR ${msg}`);
    }
  }

  // Issues (incremental via updatedAt cursor, or full + prune).
  let issuesChanged = 0;
  let commentsHydrated = 0;
  let changedIds: string[] = [];
  try {
    const rows = await fetchIssues(api, companyId, since, log);
    const at = runStamp(startedAt);
    const prevUpdated = new Map<string, string | null>();
    if (rows.length > 0) {
      const ids = rows.map((r) => String(r.id));
      // Chunk the IN() lookup (SQLite variable limit).
      for (let i = 0; i < ids.length; i += 500) {
        const chunk = ids.slice(i, i + 500);
        const q = db.query<{ id: string; updated_at: string | null }, string[]>(
          `SELECT id, updated_at FROM issues WHERE id IN (${chunk.map(() => "?").join(",")})`,
        );
        for (const r of q.all(...chunk)) prevUpdated.set(r.id, r.updated_at);
      }
    }
    db.transaction(() => {
      for (const r of rows) {
        const id = String(r.id);
        const upd = typeof r.updatedAt === "string" ? r.updatedAt : null;
        if (!prevUpdated.has(id) || prevUpdated.get(id) !== upd) {
          issuesChanged += 1;
          changedIds.push(id);
        }
        upsertIssue(db, r, at);
      }
    })();
    let pruned = 0;
    if (mode === "full" && !opts.since) pruned = pruneNotSyncedSince(db, "issues", companyId, startedAt);

    // Cursor = newest updatedAt seen (minus nothing: overlap is idempotent).
    let newest = issueState?.cursor ?? null;
    for (const r of rows) {
      const u = typeof r.updatedAt === "string" ? r.updatedAt : null;
      if (u && (!newest || Date.parse(u) > Date.parse(newest))) newest = u;
    }
    entities.push({ entity: "issues", count: rows.length, pruned, status: "ok" });
    putSyncState(db, {
      profile, company_id: companyId, entity: "issues",
      cursor: newest, last_sync_at: at, last_full_at: mode === "full" ? at : undefined,
      last_status: "ok", last_error: null, last_count: rows.length,
    });
    log(`  issues: ${rows.length} listed, ${issuesChanged} changed${pruned ? `, pruned ${pruned}` : ""}`);
  } catch (err) {
    const msg = describeApiError(err);
    entities.push({ entity: "issues", count: 0, status: "error", error: msg });
    putSyncState(db, { profile, company_id: companyId, entity: "issues", last_status: "error", last_error: msg });
    log(`  issues: ERROR ${msg}`);
    return finish("partial", issuesChanged, commentsHydrated);
  }

  // Comments.
  if (commentsMode !== "none") {
    let ids: string[];
    if (commentsMode === "all" || mode === "full") {
      ids = db.query<{ id: string }, [string]>("SELECT id FROM issues WHERE company_id=?").all(companyId).map((r) => r.id);
    } else {
      const active = db.query<{ id: string }, [string]>(
        `SELECT id FROM issues WHERE company_id=? AND status IN (${[...ACTIVE_STATUSES].map((st) => `'${st}'`).join(",")})`,
      ).all(companyId).map((r) => r.id);
      ids = [...new Set([...changedIds, ...active])];
    }
    if (ids.length > 0) {
      log(`  comments: hydrating ${ids.length} issue thread(s)`);
      const res = await hydrateComments(db, api, ids, concurrency, log);
      commentsHydrated = res.hydrated;
      entities.push({ entity: "comments", count: res.hydrated, status: res.failed === 0 ? "ok" : res.hydrated > 0 ? "ok" : "error", error: res.failed ? `${res.failed} thread(s) failed` : undefined });
      putSyncState(db, { profile, company_id: companyId, entity: "comments", last_sync_at: nowIso(), last_status: res.failed === 0 ? "ok" : "partial", last_error: res.failed ? `${res.failed} failed` : null, last_count: res.hydrated });
    } else {
      entities.push({ entity: "comments", count: 0, status: "skipped" });
    }
  }

  return finish(entities.some((e) => e.status === "error") ? "partial" : "ok", issuesChanged, commentsHydrated);

  function finish(status: CompanySyncResult["status"], changed: number, hydrated: number): CompanySyncResult {
    return { profile, companyId, apiBase, startedAt, finishedAt: nowIso(), mode, entities, issuesChanged: changed, commentsHydrated: hydrated, status };
  }
}

/** Deep-hydrate one issue (by UUID or identifier like CCS-12) plus its full comment thread. */
export async function syncOneIssue(db: Database, api: PaperclipReader, idOrIdentifier: string): Promise<{ issue: Rec; comments: number }> {
  const issue = await api.get<Rec>(apiPath`/api/issues/${idOrIdentifier}`);
  if (!issue || typeof issue.id !== "string") throw new Error(`Issue not found upstream: ${idOrIdentifier}`);
  const at = syncStamp(db);
  upsertIssue(db, issue, at);
  const comments = await fetchAllComments(api, issue.id);
  db.transaction(() => {
    for (const c of comments) upsertComment(db, c, at);
    deleteCommentsNotSyncedSince(db, issue.id as string, at);
    markCommentsSynced(db, issue.id as string, at);
  })();
  return { issue, comments: comments.length };
}
