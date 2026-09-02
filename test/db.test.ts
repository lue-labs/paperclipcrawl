import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import { currentSchemaVersion, getMeta, hasFts5, journalMode, migrate, openDb, setMeta, tableCounts } from "../src/lib/db.ts";
import { SCHEMA_VERSION } from "../src/lib/schema.ts";
import { upsertIssue, upsertAgent, upsertComment } from "../src/lib/store.ts";
import { REDACTED } from "../src/lib/redact.ts";
import { search, getIssue, listIssues, toFtsQuery } from "../src/lib/query.ts";
import { comment, issue, tmpDb } from "./helpers.ts";

let cleanup: (() => void) | undefined;
afterEach(() => { cleanup?.(); cleanup = undefined; });

describe("db", () => {
  test("migrate is idempotent, WAL + FTS5 enabled, perms tight", () => {
    const t = tmpDb(); cleanup = t.cleanup;
    expect(currentSchemaVersion(t.db)).toBe(SCHEMA_VERSION);
    expect(migrate(t.db)).toEqual({ from: SCHEMA_VERSION, to: SCHEMA_VERSION });
    expect(journalMode(t.db).toLowerCase()).toBe("wal");
    expect(hasFts5(t.db)).toBe(true);
    expect(fs.statSync(t.dbPath).mode & 0o077).toBe(0);
    expect(fs.statSync(t.dir).mode & 0o077).toBe(0);
    expect(Object.values(tableCounts(t.db)).every((n) => n === 0)).toBe(true);
  });

  test("refuses to open a DB with a newer schema", () => {
    const t = tmpDb(); cleanup = t.cleanup;
    setMeta(t.db, "schema_version", String(SCHEMA_VERSION + 1));
    expect(() => migrate(t.db)).toThrow(/newer/i);
    expect(getMeta(t.db, "schema_version")).toBe(String(SCHEMA_VERSION + 1));
  });

  test("readonly connection rejects writes even via query_only", () => {
    const t = tmpDb(); cleanup = t.cleanup;
    t.db.close();
    const ro = openDb(t.dbPath, { readonly: true });
    expect(() => ro.exec("INSERT INTO meta (key, value) VALUES ('x','y')")).toThrow();
    expect(() => ro.exec("DELETE FROM issues")).toThrow();
    expect(ro.query("SELECT count(*) AS n FROM issues").get()).toEqual({ n: 0 });
    ro.close();
  });
});

describe("store + search", () => {
  test("upsert keeps FTS in sync; secrets redacted at write time", () => {
    const t = tmpDb(); cleanup = t.cleanup;
    const now = new Date().toISOString();
    upsertIssue(t.db, issue(1, { title: "Ledger reconciliation blocked", description: "waiting on bank export" }), now);
    upsertIssue(t.db, issue(2, { title: "Sync lock design", status: "in_progress" }), now);
    upsertComment(t.db, comment(String(issue(2).id), 1, "the singleflight lock uses O_EXCL"), now);
    upsertAgent(t.db, { id: "agent-1", companyId: issue(1).companyId, name: "Ops", adapterConfig: { apiKey: "sk-live-LEAK" }, runtimeConfig: { token: "LEAK2" }, metadata: { note: "LEAK3" } }, now);

    expect(search(t.db, "ledger").map((h) => h.identifier)).toEqual(["TST-1"]);
    expect(search(t.db, "singleflight", { includeComments: true }).map((h) => h.kind)).toEqual(["comment"]);
    expect(search(t.db, "TST-2").map((h) => h.identifier)).toEqual(["TST-2"]);
    expect(search(t.db, "ledger", { status: ["in_progress"] })).toHaveLength(0);

    // Update title → FTS reflects new text, old text gone.
    upsertIssue(t.db, issue(1, { title: "Renamed: invoices", updatedAt: new Date(Date.now() + 1000).toISOString() }), now);
    expect(search(t.db, "ledger")).toHaveLength(0);
    expect(search(t.db, "invoices").map((h) => h.identifier)).toEqual(["TST-1"]);

    const raw = t.db.query<{ raw_json: string }, []>("SELECT raw_json FROM agents").get()!.raw_json;
    expect(raw).not.toContain("LEAK");
    expect(JSON.parse(raw).adapterConfig).toBe(REDACTED);
    const iraw = t.db.query<{ raw_json: string }, []>("SELECT raw_json FROM issues WHERE identifier='TST-1'").get()!.raw_json;
    expect(iraw).not.toContain("SHOULD_NOT_PERSIST");
  });

  test("issue list filters + get by identifier (case-insensitive) with comments", () => {
    const t = tmpDb(); cleanup = t.cleanup;
    const now = new Date().toISOString();
    upsertIssue(t.db, issue(1, { status: "done" }), now);
    upsertIssue(t.db, issue(2, { status: "in_progress", assigneeAgentId: "agent-1" }), now);
    upsertIssue(t.db, issue(3, { status: "todo", companyId: "other-co" }), now);
    upsertComment(t.db, comment(String(issue(2).id), 1), now);
    upsertComment(t.db, comment(String(issue(2).id), 2), now);

    expect(listIssues(t.db, { companyId: issue(1).companyId as string }).map((r) => r.identifier)).toEqual(["TST-2", "TST-1"]);
    expect(listIssues(t.db, { status: ["in_progress"] }).map((r) => r.identifier)).toEqual(["TST-2"]);
    expect(listIssues(t.db, { assigneeAgentId: "agent-1" })).toHaveLength(1);
    expect(listIssues(t.db, { match: "issue 3" }).map((r) => r.identifier)).toEqual(["TST-3"]);
    expect(listIssues(t.db, { limit: 1 })).toHaveLength(1);

    const d = getIssue(t.db, "tst-2");
    expect(d?.row.identifier).toBe("TST-2");
    expect(d?.comments.map((c) => c.body)).toEqual(["comment 1", "comment 2"]);
    expect(getIssue(t.db, "TST-3", issue(1).companyId as string)).toBeNull();
    expect(getIssue(t.db, String(issue(1).id))?.row.identifier).toBe("TST-1");
  });

  test("toFtsQuery neutralises operators and hyphens", () => {
    expect(toFtsQuery("CCS-12")).toBe('"CCS-12"*');
    expect(toFtsQuery("sync lock")).toBe('"sync"* "lock"*');
    expect(toFtsQuery('"exact phrase"')).toBe('"exact phrase"');
    expect(toFtsQuery("a OR b NOT c")).toBe('"a"* "OR"* "b"* "NOT"* "c"*');
    expect(toFtsQuery("")).toBe('""');
  });
});
