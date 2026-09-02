#!/usr/bin/env bun
import { parseArgs } from "node:util";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { ApiClient, describeApiError } from "./lib/api.ts";
import { readContext, resolveAllTargets, resolveAuthStorePath, resolveTarget, type ResolvedTarget } from "./lib/context.ts";
import { currentSchemaVersion, dbExists, DbMissingError, getMeta, hasFts5, journalMode, migrate, openDb, rebuildFts, setMeta, sqliteVersion, tableCounts } from "./lib/db.ts";
import { acquireLock, LockHeldError, readLock } from "./lib/lock.ts";
import { parseDuration, printJson, relTime, table, truncate, warn } from "./lib/output.ts";
import { APP_ID, dataDirForDb, lockPathForDb, resolveDbPath } from "./lib/paths.ts";
import { companiesSummary, getIssue, listIssues, search } from "./lib/query.ts";
import { SCHEMA_VERSION } from "./lib/schema.ts";
import { allSyncState, lastSyncAt } from "./lib/store.ts";
import { syncCompany, syncOneIssue, type CompanySyncResult } from "./lib/sync.ts";

const VERSION = "0.1.0";
/** Data older than this is reported as "stale" in status and hinted on read commands. */
const STALE_AFTER_MS = Number(process.env.PAPERCLIPCRAWL_STALE_AFTER_MS ?? 30 * 60 * 1000);

const HELP = `paperclipcrawl ${VERSION} — offline SQLite mirror for Paperclip (read-only; mutate with paperclipai)

Usage: paperclipcrawl <command> [options]

Commands
  init                               Create the data dir + database (idempotent)
  doctor [--json]                    Check paths, schema, WAL, FTS5, auth resolution, no-secrets
  status [--json]                    crawlkit.control.v1 control surface: counts, last sync, staleness
  sync [--profile N | --all] [--company-id ID] [--since ISO] [--full]
       [--comments none|changed|all] [--if-stale 5m] [--json] [--quiet]
                                     Pull companies/issues/comments/approvals/agents/projects
  sync issue <idOrIdentifier>        Deep-hydrate one issue + its full comment thread
  search <query> [--company-id ID] [--status csv] [--comments] [--limit N] [--json]
  issue list [--company-id ID] [--status csv] [--assignee-agent-id ID] [--project-id ID]
             [--match text] [--limit N] [--json]
  issue get <idOrIdentifier> [--company-id ID] [--json] [--raw]
  sql '<select …>' [--json]          Read-only SQL against the mirror
  maintain [--vacuum]                Checkpoint WAL, rebuild FTS, optionally VACUUM

Global options
  --db PATH          Database path (or PAPERCLIPCRAWL_DB). Default:
                     macOS ~/Library/Application Support/paperclipcrawl/paperclipcrawl.db
                     Linux \${XDG_DATA_HOME:-~/.local/share}/paperclipcrawl/paperclipcrawl.db
  --profile NAME     Paperclip context profile (~/.paperclip/context.json); default: currentProfile
  --context PATH     Paperclip context file (or PAPERCLIP_CONTEXT)
  --api-base URL     Override API base (or PAPERCLIP_API_URL)
  --api-key TOKEN    Override bearer token (or PAPERCLIP_API_KEY); never persisted
  -C, --company-id   Company id (or PAPERCLIP_COMPANY_ID); default: profile companyId
  --json             Machine-readable output
  -h, --help         Show help
  -V, --version      Show version

Read commands (search, issue, sql, status) never touch the network.
Auth reuses paperclipai's context/auth files; tokens are never written to SQLite.
`;

interface Opts {
  db?: string; profile?: string; context?: string; apiBase?: string; apiKey?: string; companyId?: string;
  json?: boolean; help?: boolean; version?: boolean; all?: boolean; full?: boolean; since?: string;
  comments?: string; ifStale?: string; quiet?: boolean; vacuum?: boolean; status?: string;
  assigneeAgentId?: string; projectId?: string; match?: string; limit?: string; raw?: boolean;
  includeComments?: boolean; concurrency?: string;
}

function parse(argv: string[]): { opts: Opts; positionals: string[] } {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    strict: true,
    options: {
      db: { type: "string" },
      profile: { type: "string" },
      context: { type: "string" },
      "api-base": { type: "string" },
      "api-key": { type: "string" },
      "company-id": { type: "string", short: "C" },
      json: { type: "boolean" },
      help: { type: "boolean", short: "h" },
      version: { type: "boolean", short: "V" },
      all: { type: "boolean" },
      full: { type: "boolean" },
      since: { type: "string" },
      comments: { type: "string" },
      "if-stale": { type: "string" },
      quiet: { type: "boolean", short: "q" },
      vacuum: { type: "boolean" },
      status: { type: "string" },
      "assignee-agent-id": { type: "string" },
      "project-id": { type: "string" },
      match: { type: "string" },
      limit: { type: "string" },
      raw: { type: "boolean" },
      "with-comments": { type: "boolean" },
      concurrency: { type: "string" },
    },
  });
  const v = values as Record<string, string | boolean | undefined>;
  return {
    opts: {
      db: v.db as string | undefined, profile: v.profile as string | undefined, context: v.context as string | undefined,
      apiBase: v["api-base"] as string | undefined, apiKey: v["api-key"] as string | undefined, companyId: v["company-id"] as string | undefined,
      json: Boolean(v.json), help: Boolean(v.help), version: Boolean(v.version), all: Boolean(v.all), full: Boolean(v.full),
      since: v.since as string | undefined, comments: v.comments as string | undefined, ifStale: v["if-stale"] as string | undefined,
      quiet: Boolean(v.quiet), vacuum: Boolean(v.vacuum), status: v.status as string | undefined,
      assigneeAgentId: v["assignee-agent-id"] as string | undefined, projectId: v["project-id"] as string | undefined,
      match: v.match as string | undefined, limit: v.limit as string | undefined, raw: Boolean(v.raw),
      includeComments: Boolean(v["with-comments"]), concurrency: v.concurrency as string | undefined,
    },
    positionals,
  };
}

function csv(v?: string): string[] | undefined {
  if (!v) return undefined;
  const parts = v.split(",").map((x) => x.trim()).filter(Boolean);
  return parts.length ? parts : undefined;
}

function fail(msg: string, code = 1): never {
  process.stderr.write(`${msg}\n`);
  process.exit(code);
}

/** Company scope for read commands: --company-id > PAPERCLIP_COMPANY_ID > profile.companyId (if --profile given) > all. */
function readScope(opts: Opts): string | null {
  if (opts.companyId?.trim()) return opts.companyId.trim();
  if (process.env.PAPERCLIP_COMPANY_ID?.trim()) return process.env.PAPERCLIP_COMPANY_ID.trim();
  if (opts.profile) {
    try {
      return resolveTarget(readContext(opts.context), { profile: opts.profile }).companyId;
    } catch { return null; }
  }
  return null;
}

function staleness(db: ReturnType<typeof openDb>): { lastSyncAt: string | null; state: "missing" | "empty" | "current" | "stale" } {
  const last = lastSyncAt(db);
  if (!last) return { lastSyncAt: null, state: "empty" };
  const age = Date.now() - Date.parse(last);
  return { lastSyncAt: last, state: age > STALE_AFTER_MS ? "stale" : "current" };
}

function hintIfStale(db: ReturnType<typeof openDb>, json: boolean): void {
  const s = staleness(db);
  if (s.state === "stale" && !json) warn(`note: mirror last synced ${relTime(s.lastSyncAt)}; run \`paperclipcrawl sync\` when online`);
  if (s.state === "empty" && !json) warn("note: mirror is empty; run `paperclipcrawl sync`");
}

// ───────────────────────────── commands ─────────────────────────────

function cmdInit(opts: Opts): void {
  const dbPath = resolveDbPath(opts.db);
  const db = openDb(dbPath, { create: true });
  const { from, to } = migrate(db);
  setMeta(db, "app_id", APP_ID);
  setMeta(db, "app_version", VERSION);
  db.close();
  if (opts.json) printJson({ ok: true, db_path: dbPath, schema_from: from, schema_to: to });
  else process.stdout.write(`${from === 0 ? "created" : from === to ? "ok" : "migrated"} ${dbPath} (schema v${to})\n`);
}

function cmdDoctor(opts: Opts): void {
  const dbPath = resolveDbPath(opts.db);
  const dataDir = dataDirForDb(dbPath);
  const checks: Array<{ id: string; ok: boolean; detail: string }> = [];
  const push = (id: string, ok: boolean, detail: string) => checks.push({ id, ok, detail });

  const dirExists = fs.existsSync(dataDir);
  push("data_dir", dirExists, dataDir + (dirExists ? "" : " (missing — run init)"));
  if (dirExists) {
    const mode = fs.statSync(dataDir).mode & 0o777;
    push("data_dir_mode", (mode & 0o077) === 0, `0${mode.toString(8)}${(mode & 0o077) ? " (group/other readable; expected 0700)" : ""}`);
  }
  const exists = dbExists(dbPath);
  push("db_exists", exists, dbPath);
  let schema = 0;
  let db: ReturnType<typeof openDb> | null = null;
  if (exists) {
    const mode = fs.statSync(dbPath).mode & 0o777;
    push("db_mode", (mode & 0o077) === 0, `0${mode.toString(8)}${(mode & 0o077) ? " (expected 0600)" : ""}`);
    try {
      db = openDb(dbPath, { readonly: true });
      schema = currentSchemaVersion(db);
      push("schema_version", schema === SCHEMA_VERSION, `${schema} (supported ${SCHEMA_VERSION})${schema < SCHEMA_VERSION ? " — run init to migrate" : schema > SCHEMA_VERSION ? " — newer than binary" : ""}`);
      const jm = journalMode(db);
      push("journal_mode", jm.toLowerCase() === "wal", jm);
      push("fts5", hasFts5(db), `sqlite ${sqliteVersion(db)}`);
    } catch (err) {
      push("db_open", false, err instanceof Error ? err.message : String(err));
    }
  }

  // Auth resolution — report source kinds only; never the token.
  const ctx = readContext(opts.context);
  push("context_file", ctx.exists, `${ctx.path}${ctx.exists ? ` (${Object.keys(ctx.profiles).length} profiles, current=${ctx.currentProfile})` : " (missing)"}`);
  const authStore = resolveAuthStorePath();
  push("auth_store", fs.existsSync(authStore), authStore);
  const lock = readLock(lockPathForDb(dbPath));
  push("sync_lock", true, lock ? `held by pid ${lock.pid} since ${lock.startedAt}` : "free");

  let targets: ResolvedTarget[] = [];
  const authTargets: Array<{ profile: string; api_base: string; company_id: string | null; auth_source: string }> = [];
  try {
    targets = opts.all ? resolveAllTargets(ctx, { contextPath: opts.context, apiBase: opts.apiBase, apiKey: opts.apiKey })
      : [resolveTarget(ctx, { profile: opts.profile, apiBase: opts.apiBase, apiKey: opts.apiKey, companyId: opts.companyId })];
    for (const t of targets) authTargets.push({ profile: t.profileName, api_base: t.apiBase, company_id: t.companyId, auth_source: t.authSource });
    push("auth_resolves", targets.every((t) => t.authSource !== "none"), targets.map((t) => `${t.profileName}:${t.authSource}`).join(", "));
  } catch (err) {
    push("auth_resolves", false, err instanceof Error ? err.message : String(err));
  }

  // No-secrets self-check: the resolved token bytes must not appear anywhere in the DB.
  if (db && targets.length > 0) {
    const tokens = [...new Set(targets.map((t) => t.apiKey).filter((k): k is string => Boolean(k && k.length >= 12)))];
    let leaked = 0;
    for (const tok of tokens) {
      const like = `%${tok}%`;
      for (const t of ["companies", "issues", "comments", "approvals", "agents", "projects"]) {
        const n = db.query<{ n: number }, [string]>(`SELECT count(*) AS n FROM ${t} WHERE raw_json LIKE ?`).get(like)?.n ?? 0;
        leaked += n;
      }
      const m = db.query<{ n: number }, [string]>("SELECT count(*) AS n FROM meta WHERE value LIKE ?").get(like)?.n ?? 0;
      leaked += m;
    }
    push("no_secrets_in_db", leaked === 0, tokens.length ? `${tokens.length} resolved token(s) scanned, ${leaked} leak(s)` : "no token resolved to scan");
    const rawSecretKeys = db.query<{ n: number }, []>(
      `SELECT count(*) AS n FROM agents WHERE raw_json LIKE '%"adapterConfig":{%'`,
    ).get()?.n ?? 0;
    push("agents_redacted", rawSecretKeys === 0, rawSecretKeys ? `${rawSecretKeys} agent rows carry raw adapterConfig` : "adapterConfig/runtimeConfig redacted");
  }

  db?.close();
  const ok = checks.every((c) => c.ok);
  if (opts.json) {
    printJson({ ok, app_id: APP_ID, version: VERSION, db_path: dbPath, data_dir: dataDir, schema_version: schema, supported_schema_version: SCHEMA_VERSION, checks, auth: authTargets, next_steps: ok ? [] : nextSteps(checks) });
  } else {
    for (const c of checks) process.stdout.write(`${c.ok ? "ok  " : "FAIL"} ${c.id.padEnd(18)} ${c.detail}\n`);
    if (!ok) for (const s of nextSteps(checks)) process.stdout.write(`→ ${s}\n`);
  }
  if (!ok) process.exitCode = 1;
}

function nextSteps(checks: Array<{ id: string; ok: boolean }>): string[] {
  const out: string[] = [];
  const bad = new Set(checks.filter((c) => !c.ok).map((c) => c.id));
  if (bad.has("data_dir") || bad.has("db_exists") || bad.has("schema_version")) out.push("Run: paperclipcrawl init");
  if (bad.has("data_dir_mode") || bad.has("db_mode")) out.push("Tighten perms: chmod 700 <data_dir>; chmod 600 <db>");
  if (bad.has("auth_resolves")) out.push("Auth: run `paperclipai connect` (board) or export PAPERCLIP_API_KEY; paperclipcrawl reuses ~/.paperclip/{context,auth}.json");
  if (bad.has("no_secrets_in_db") || bad.has("agents_redacted")) out.push("Secrets detected in mirror: delete the DB and re-sync with this binary (redaction is applied at write time)");
  return out;
}

function cmdStatus(opts: Opts): void {
  const dbPath = resolveDbPath(opts.db);
  if (!dbExists(dbPath)) {
    if (opts.json) printJson({ schema_version: "crawlkit.control.v1", app_id: APP_ID, generated_at: new Date().toISOString(), state: "missing", summary: "database missing — run paperclipcrawl init", database_path: dbPath, counts: [], next_steps: ["paperclipcrawl init", "paperclipcrawl sync"] });
    else process.stdout.write(`missing: ${dbPath}\n→ paperclipcrawl init && paperclipcrawl sync\n`);
    process.exitCode = 1;
    return;
  }
  const db = openDb(dbPath, { readonly: true });
  const counts = tableCounts(db);
  const s = staleness(db);
  const companies = companiesSummary(db);
  const syncState = allSyncState(db);
  const lock = readLock(lockPathForDb(dbPath));
  const summary = `${counts.issues} issues across ${counts.companies} compan${counts.companies === 1 ? "y" : "ies"}; last sync ${relTime(s.lastSyncAt)}`;
  db.close();

  if (opts.json) {
    printJson({
      schema_version: "crawlkit.control.v1",
      app_id: APP_ID,
      app_version: VERSION,
      generated_at: new Date().toISOString(),
      state: s.state,
      summary,
      database_path: dbPath,
      db_schema_version: SCHEMA_VERSION,
      last_sync_at: s.lastSyncAt,
      stale_after_ms: STALE_AFTER_MS,
      sync_lock: lock ? { held: true, pid: lock.pid, host: lock.host, started_at: lock.startedAt } : { held: false },
      counts: Object.entries(counts).map(([id, value]) => ({ id, label: id[0]!.toUpperCase() + id.slice(1), value })),
      companies,
      sync_state: syncState,
      next_steps: s.state === "current" ? [] : ["paperclipcrawl sync"],
    });
    return;
  }
  process.stdout.write(`${APP_ID} ${VERSION} · ${s.state} · ${summary}\n`);
  process.stdout.write(`db: ${dbPath}\n`);
  if (lock) process.stdout.write(`sync lock: held by pid ${lock.pid} (${lock.host}) since ${lock.startedAt}\n`);
  process.stdout.write(`counts: ${Object.entries(counts).map(([k, v]) => `${k}=${v}`).join(" ")}\n`);
  if (companies.length) {
    process.stdout.write("\n");
    process.stdout.write(table(companies.map((c) => ({ ...c, last_sync: relTime(c.last_sync_at) })), [
      { key: "issue_prefix", label: "prefix" }, { key: "name", label: "company", width: 28 }, { key: "issues", label: "issues" },
      { key: "open_issues", label: "open" }, { key: "last_sync", label: "last sync" }, { key: "id", label: "company_id" },
    ]));
  }
  const errors = syncState.filter((r) => r.last_status && r.last_status !== "ok");
  if (errors.length) {
    process.stdout.write("\nlast errors:\n");
    for (const e of errors) process.stdout.write(`  ${e.profile}/${e.entity}: ${truncate(e.last_error, 100)}\n`);
  }
}

async function cmdSync(opts: Opts, positionals: string[]): Promise<void> {
  const dbPath = resolveDbPath(opts.db);
  if (!dbExists(dbPath)) {
    // First run convenience: init implicitly so `paperclipcrawl sync` is a one-liner.
    const db0 = openDb(dbPath, { create: true });
    migrate(db0);
    setMeta(db0, "app_id", APP_ID);
    db0.close();
  }
  const ctx = readContext(opts.context);
  const log = opts.quiet || opts.json ? () => {} : (l: string) => process.stderr.write(`${l}\n`);

  // sync issue <id>
  if (positionals[0] === "issue") {
    const id = positionals[1];
    if (!id) fail("usage: paperclipcrawl sync issue <idOrIdentifier>");
    const target = resolveTarget(ctx, { profile: opts.profile, apiBase: opts.apiBase, apiKey: opts.apiKey, companyId: opts.companyId });
    const db = openDb(dbPath, { create: true });
    migrate(db);
    const lock = acquireLock(lockPathForDb(dbPath));
    try {
      const api = new ApiClient({ apiBase: target.apiBase, apiKey: target.apiKey });
      const res = await syncOneIssue(db, api, id);
      if (opts.json) printJson({ ok: true, issue_id: res.issue.id, identifier: res.issue.identifier ?? null, comments: res.comments });
      else process.stdout.write(`synced ${res.issue.identifier ?? res.issue.id} (${res.comments} comments)\n`);
    } catch (err) {
      fail(describeApiError(err));
    } finally {
      lock.release();
      db.close();
    }
    return;
  }
  if (positionals.length > 0) fail(`unknown sync target '${positionals.join(" ")}' (did you mean: sync issue <id>?)`);

  // Targets.
  let targets: ResolvedTarget[];
  if (opts.all) {
    targets = resolveAllTargets(ctx, { contextPath: opts.context, apiBase: opts.apiBase, apiKey: opts.apiKey });
    if (opts.companyId) targets = targets.filter((t) => t.companyId === opts.companyId);
  } else {
    const t = resolveTarget(ctx, { profile: opts.profile, apiBase: opts.apiBase, apiKey: opts.apiKey, companyId: opts.companyId });
    if (!t.companyId) fail(`Profile '${t.profileName}' has no companyId. Pass --company-id, or use --all.`);
    targets = [t];
  }
  if (targets.length === 0) fail("No sync targets resolved (no profile has a companyId).");

  const db = openDb(dbPath, { create: true });
  migrate(db);

  if (opts.ifStale) {
    const maxAge = parseDuration(opts.ifStale);
    const last = lastSyncAt(db);
    if (last && Date.now() - Date.parse(last) < maxAge) {
      if (opts.json) printJson({ skipped: true, reason: "fresh", last_sync_at: last });
      else log(`fresh (last sync ${relTime(last)} < ${opts.ifStale}); skipping`);
      db.close();
      return;
    }
  }

  const comments = (opts.comments ?? "changed") as "none" | "changed" | "all";
  if (!["none", "changed", "all"].includes(comments)) fail("--comments must be none|changed|all");
  const concurrency = opts.concurrency ? Math.max(1, Number(opts.concurrency) || 4) : 4;

  let lock;
  try {
    lock = acquireLock(lockPathForDb(dbPath));
  } catch (err) {
    if (err instanceof LockHeldError) fail(err.message, 75);
    throw err;
  }

  const startedAt = new Date().toISOString();
  const runId = db.query("INSERT INTO sync_runs (started_at, mode, profiles) VALUES (?, ?, ?)")
    .run(startedAt, opts.full ? "full" : "incremental", targets.map((t) => t.profileName).join(",")).lastInsertRowid;
  const results: CompanySyncResult[] = [];
  try {
    for (const t of targets) {
      if (t.authSource === "none") log(`[${t.profileName}] warning: no credential resolved; requests will be unauthenticated`);
      const api = new ApiClient({ apiBase: t.apiBase, apiKey: t.apiKey });
      const r = await syncCompany(db, api, t, { full: opts.full, since: opts.since, comments, concurrency, log });
      results.push(r);
    }
  } finally {
    const status = results.every((r) => r.status === "ok") ? "ok" : results.some((r) => r.status !== "error") ? "partial" : "error";
    db.query("UPDATE sync_runs SET finished_at=?, status=?, summary_json=? WHERE id=?")
      .run(new Date().toISOString(), status, JSON.stringify(results.map((r) => ({ profile: r.profile, companyId: r.companyId, status: r.status, issuesChanged: r.issuesChanged, commentsHydrated: r.commentsHydrated }))), runId);
    setMeta(db, "last_sync_at", new Date().toISOString());
    lock.release();
    db.close();
  }

  const overall = results.every((r) => r.status === "ok") ? "ok" : results.some((r) => r.status !== "error") ? "partial" : "error";
  if (opts.json) {
    printJson({ ok: overall === "ok", status: overall, db_path: dbPath, results });
  } else {
    for (const r of results) {
      const ent = r.entities.map((e) => `${e.entity}=${e.status === "ok" ? e.count : e.status}`).join(" ");
      process.stdout.write(`${r.status.padEnd(7)} ${r.profile.padEnd(14)} ${r.mode.padEnd(11)} ${ent}\n`);
      for (const e of r.entities.filter((x) => x.error)) process.stdout.write(`        ${e.entity}: ${e.error}\n`);
    }
  }
  if (overall === "error") process.exitCode = 1;
  else if (overall === "partial") process.exitCode = 2;
}

function cmdSearch(opts: Opts, positionals: string[]): void {
  const q = positionals.join(" ").trim();
  if (!q) fail("usage: paperclipcrawl search <query> [--company-id ID] [--status csv] [--with-comments] [--limit N] [--json]");
  const db = openDb(resolveDbPath(opts.db), { readonly: true });
  hintIfStale(db, Boolean(opts.json));
  const hits = search(db, q, { companyId: readScope(opts), status: csv(opts.status), limit: opts.limit ? Number(opts.limit) : 25, includeComments: opts.includeComments });
  db.close();
  if (opts.json) { printJson(hits); return; }
  process.stdout.write(table(hits.map((h) => ({ ...h })), [
    { key: "kind", label: "kind" }, { key: "identifier", label: "id" }, { key: "status", label: "status" },
    { key: "title", label: "title", width: 60 }, { key: "snippet", label: "match", width: 70 },
  ]));
}

function cmdIssue(opts: Opts, positionals: string[]): void {
  const sub = positionals[0];
  const db = openDb(resolveDbPath(opts.db), { readonly: true });
  try {
    if (sub === "list") {
      hintIfStale(db, Boolean(opts.json));
      const rows = listIssues(db, {
        companyId: readScope(opts), status: csv(opts.status), assigneeAgentId: opts.assigneeAgentId, projectId: opts.projectId,
        match: opts.match, limit: opts.limit ? Number(opts.limit) : undefined,
      });
      if (opts.json) { printJson(rows); return; }
      process.stdout.write(table(rows.map((r) => ({ ...r, updated: relTime(r.updated_at), assignee: r.assignee_name ?? (r.assignee_agent_id ? r.assignee_agent_id.slice(0, 8) : "") })), [
        { key: "identifier", label: "id" }, { key: "status", label: "status" }, { key: "priority", label: "pri" },
        { key: "title", label: "title", width: 70 }, { key: "assignee", label: "assignee", width: 18 }, { key: "updated", label: "updated" },
      ]));
      return;
    }
    if (sub === "get") {
      const id = positionals[1];
      if (!id) fail("usage: paperclipcrawl issue get <idOrIdentifier> [--json] [--raw]");
      hintIfStale(db, Boolean(opts.json));
      const d = getIssue(db, id, readScope(opts));
      if (!d) fail(`not in mirror: ${id} (try: paperclipcrawl sync issue ${id})`, 3);
      if (opts.raw) { printJson(d.raw); return; }
      if (opts.json) { printJson({ ...d.raw, _mirror: { synced_at: d.row.synced_at, comments_synced_at: d.row.comments_synced_at }, comments: d.comments }); return; }
      const r = d.row;
      process.stdout.write(`${r.identifier ?? r.id}  ${r.status}${r.priority ? `  ${r.priority}` : ""}\n${r.title}\n`);
      process.stdout.write(`assignee: ${r.assignee_name ?? r.assignee_agent_id ?? "-"}  updated: ${r.updated_at ?? "-"}  synced: ${relTime(r.synced_at)}\n`);
      if (r.description) process.stdout.write(`\n${r.description.trim()}\n`);
      if (d.comments.length) {
        process.stdout.write(`\n— ${d.comments.length} comment(s)${r.comments_synced_at ? ` (synced ${relTime(r.comments_synced_at)})` : ""} —\n`);
        for (const c of d.comments) process.stdout.write(`\n[${c.created_at ?? "?"}] ${c.author_name ?? c.author_agent_id ?? c.author_user_id ?? c.author_type ?? "?"}:\n${c.body.trim()}\n`);
      }
      return;
    }
    fail("usage: paperclipcrawl issue list|get …");
  } finally {
    db.close();
  }
}

function cmdSql(opts: Opts, positionals: string[]): void {
  const sqlText = positionals.join(" ").trim();
  if (!sqlText) fail("usage: paperclipcrawl sql '<select …>' [--json]");
  if (!/^\s*(select|with|explain|pragma\s+(table_info|table_list|index_list|foreign_key_list))\b/i.test(sqlText)) {
    fail("sql: read-only — statement must start with SELECT, WITH, or EXPLAIN", 2);
  }
  // Belt and braces: readonly connection + query_only pragma (openDb) reject any write.
  const db = openDb(resolveDbPath(opts.db), { readonly: true });
  try {
    const rows = db.query<Record<string, unknown>, []>(sqlText).all();
    if (opts.json) { printJson(rows); return; }
    if (rows.length === 0) { process.stdout.write("(empty)\n"); return; }
    const cols = Object.keys(rows[0]!).map((k) => ({ key: k, label: k, width: 80 }));
    process.stdout.write(table(rows, cols));
  } catch (err) {
    fail(`sql: ${err instanceof Error ? err.message : String(err)}`, 2);
  } finally {
    db.close();
  }
}

function cmdMaintain(opts: Opts): void {
  const dbPath = resolveDbPath(opts.db);
  const db = openDb(dbPath);
  const lock = acquireLock(lockPathForDb(dbPath));
  try {
    migrate(db);
    db.exec("PRAGMA wal_checkpoint(TRUNCATE);");
    rebuildFts(db);
    if (opts.vacuum) {
      db.exec("VACUUM;");
      rebuildFts(db); // rowids can move under VACUUM; external-content FTS must be rebuilt after.
    }
    db.exec("PRAGMA optimize;");
    setMeta(db, "last_maintain_at", new Date().toISOString());
    const size = fs.statSync(dbPath).size;
    if (opts.json) printJson({ ok: true, db_path: dbPath, vacuumed: Boolean(opts.vacuum), size_bytes: size });
    else process.stdout.write(`maintained ${dbPath}${opts.vacuum ? " (vacuumed)" : ""} · ${(size / 1024 / 1024).toFixed(1)} MiB\n`);
  } finally {
    lock.release();
    db.close();
  }
}

// ───────────────────────────── main ─────────────────────────────

async function main(argv: string[]): Promise<void> {
  let parsed: ReturnType<typeof parse>;
  try {
    parsed = parse(argv);
  } catch (err) {
    fail(`${err instanceof Error ? err.message : String(err)}\n\n${HELP}`, 64);
  }
  const { opts, positionals } = parsed;
  if (opts.version) { process.stdout.write(`${VERSION}\n`); return; }
  const cmd = positionals[0];
  if (opts.help || !cmd) { process.stdout.write(HELP); return; }
  const rest = positionals.slice(1);
  try {
    switch (cmd) {
      case "init": return cmdInit(opts);
      case "doctor": return cmdDoctor(opts);
      case "status": return cmdStatus(opts);
      case "sync": return await cmdSync(opts, rest);
      case "search": return cmdSearch(opts, rest);
      case "issue": return cmdIssue(opts, rest);
      case "sql": return cmdSql(opts, rest);
      case "maintain": return cmdMaintain(opts);
      case "help": process.stdout.write(HELP); return;
      default: fail(`unknown command '${cmd}'\n\n${HELP}`, 64);
    }
  } catch (err) {
    if (err instanceof DbMissingError) fail(err.message, 3);
    if (err instanceof LockHeldError) fail(err.message, 75);
    fail(err instanceof Error ? err.message : String(err));
  }
}

void main(process.argv.slice(2));

// Keep unused-import linters honest for the pieces referenced only in help text.
void path; void os; void getMeta;
