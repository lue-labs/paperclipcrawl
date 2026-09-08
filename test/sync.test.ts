import { afterEach, describe, expect, test } from "bun:test";
import { syncCompany, syncOneIssue, ISSUE_PAGE } from "../src/lib/sync.ts";
import { getSyncState, syncStamp, upsertIssue } from "../src/lib/store.ts";
import { getIssue, listIssues } from "../src/lib/query.ts";
import { comment, COMPANY_ID, issue, StubReader, TARGET, tmpDb } from "./helpers.ts";

let cleanup: (() => void) | undefined;
afterEach(() => { cleanup?.(); cleanup = undefined; });

describe("sync engine", () => {
  test("first sync is full; second is incremental via updatedAt cursor and only re-hydrates changed/active threads", async () => {
    const t = tmpDb(); cleanup = t.cleanup;
    const i1 = issue(1, { status: "done" });
    const i2 = issue(2, { status: "in_progress" });
    const i3 = issue(3, { status: "done" });
    const stub = new StubReader({
      issues: [i1, i2, i3],
      comments: { [String(i1.id)]: [comment(String(i1.id), 1)], [String(i2.id)]: [comment(String(i2.id), 1), comment(String(i2.id), 2)] },
      agents: [{ id: "agent-1", companyId: COMPANY_ID, name: "Ops", adapterConfig: { apiKey: "LEAK" } }],
      projects: [{ id: "proj-1", companyId: COMPANY_ID, name: "P", env: { SECRET: "LEAK" } }],
      approvals: [{ id: "appr-1", companyId: COMPANY_ID, type: "x", status: "pending" }],
    });

    const r1 = await syncCompany(t.db, stub, TARGET, {});
    expect(r1.mode).toBe("full");
    expect(r1.status).toBe("ok");
    expect(r1.issuesChanged).toBe(3);
    expect(r1.commentsHydrated).toBe(3); // full mode hydrates every issue
    expect(listIssues(t.db, { companyId: COMPANY_ID })).toHaveLength(3);
    expect(getIssue(t.db, "TST-2")?.comments).toHaveLength(2);
    expect(getSyncState(t.db, "test", COMPANY_ID, "issues")?.cursor).toBe(String(i3.updatedAt));
    const dump = t.db.query<{ j: string }, []>("SELECT group_concat(raw_json) AS j FROM agents").get()!.j + t.db.query<{ j: string }, []>("SELECT group_concat(raw_json) AS j FROM projects").get()!.j;
    expect(dump).not.toContain("LEAK");
    expect(dump).not.toContain(TARGET.apiKey!);

    // Upstream: i3 gets a comment without changing updatedAt (done → not re-hydrated), i1 changes (re-hydrated), i2 active (re-hydrated).
    stub.data.comments[String(i3.id)] = [comment(String(i3.id), 1, "late comment")];
    stub.data.comments[String(i2.id)]!.push(comment(String(i2.id), 3, "third"));
    const i1b = { ...i1, title: "Issue 1 renamed", updatedAt: new Date(Date.UTC(2026, 0, 3)).toISOString() };
    stub.data.issues = [i1b, i2, i3];
    stub.calls = [];

    const r2 = await syncCompany(t.db, stub, TARGET, {});
    expect(r2.mode).toBe("incremental");
    expect(r2.issuesChanged).toBe(1);
    expect(r2.commentsHydrated).toBe(2); // i1 (changed) + i2 (active); i3 is done and unchanged
    expect(getIssue(t.db, "TST-1")?.row.title).toBe("Issue 1 renamed");
    expect(getIssue(t.db, "TST-2")?.comments).toHaveLength(3);
    expect(getIssue(t.db, "TST-3")?.comments).toHaveLength(0);
    expect(stub.calls.filter((c) => c.includes(`/issues/${i3.id}/comments`))).toHaveLength(0);
    expect(getSyncState(t.db, "test", COMPANY_ID, "issues")?.cursor).toBe(i1b.updatedAt);

    // --full re-hydrates everything and prunes issues that vanished upstream.
    stub.data.issues = [i1b, i2];
    const r3 = await syncCompany(t.db, stub, TARGET, { full: true });
    expect(r3.mode).toBe("full");
    expect(r3.entities.find((e) => e.entity === "issues")?.pruned).toBe(1);
    expect(listIssues(t.db, { companyId: COMPANY_ID }).map((r) => r.identifier).sort()).toEqual(["TST-1", "TST-2"]);
    expect(t.db.query<{ n: number }, [string]>("SELECT count(*) AS n FROM comments WHERE issue_id = ?").get(String(i3.id))).toEqual({ n: 0 });
  });

  test("pagination walks all pages and stops early on incremental", async () => {
    const t = tmpDb(); cleanup = t.cleanup;
    const many = Array.from({ length: ISSUE_PAGE + 5 }, (_, i) => issue(i + 1, { status: "done" }));
    const stub = new StubReader({ issues: many, comments: {} });
    const r1 = await syncCompany(t.db, stub, TARGET, { comments: "none" });
    expect(r1.entities.find((e) => e.entity === "issues")?.count).toBe(ISSUE_PAGE + 5);
    expect(stub.calls.filter((c) => c.includes("/issues?")).length).toBe(2);

    stub.calls = [];
    const r2 = await syncCompany(t.db, stub, TARGET, { comments: "none" });
    expect(r2.mode).toBe("incremental");
    expect(r2.issuesChanged).toBe(0);
    // Newest page already older than cursor after the first page → exactly one call.
    expect(stub.calls.filter((c) => c.includes("/issues?")).length).toBe(1);
  });

  test("company 403 falls back to /api/companies list; upstream failure keeps existing data and records last_error", async () => {
    const t = tmpDb(); cleanup = t.cleanup;
    const stub = new StubReader({ issues: [issue(1)], comments: {}, failCompany: 403 });
    const r = await syncCompany(t.db, stub, TARGET, { comments: "none" });
    expect(r.status).toBe("ok");
    expect(t.db.query<{ n: number }, []>("SELECT count(*) AS n FROM companies").get()).toEqual({ n: 1 });

    // Now the whole API dies (503): mirror must keep serving what it has.
    const dead = { async get(p: string): Promise<never> { throw new (await import("../src/lib/api.ts")).ApiRequestError(503, "Service Unavailable", p); } };
    const r2 = await syncCompany(t.db, dead, TARGET, {});
    expect(r2.status).toBe("error");
    expect(listIssues(t.db, { companyId: COMPANY_ID })).toHaveLength(1);
    expect(getSyncState(t.db, "test", COMPANY_ID, "companies")?.last_error).toMatch(/503/);
    expect(getSyncState(t.db, "test", COMPANY_ID, "issues")?.last_status).toBe("ok"); // untouched by failed run
  });

  test("sync issue <identifier> deep-hydrates one issue", async () => {
    const t = tmpDb(); cleanup = t.cleanup;
    const i = issue(7);
    const stub = new StubReader({ issues: [i], comments: { [String(i.id)]: [comment(String(i.id), 1), comment(String(i.id), 2)] } });
    const r = await syncOneIssue(t.db, stub, "TST-7");
    expect(r.comments).toBe(2);
    expect(getIssue(t.db, "TST-7")?.comments).toHaveLength(2);
    await expect(syncOneIssue(t.db, stub, "TST-404")).rejects.toThrow();
  });

  test("full sync prunes a row stamped in the same millisecond the run starts (stamps are strictly monotonic)", async () => {
    // Regression: prune is `synced_at < startedAt`. A row written in the same ms as the next run's start
    // used to survive pruning. Plant a stale row stamped "now" and immediately run a full sync.
    const t = tmpDb(); cleanup = t.cleanup;
    const live = issue(1, { status: "todo" });
    const stale = issue(2, { status: "todo" });
    const stub = new StubReader({ issues: [live], comments: {} });
    upsertIssue(t.db, stale, new Date().toISOString());
    upsertIssue(t.db, live, new Date().toISOString());

    const r = await syncCompany(t.db, stub, TARGET, { full: true, comments: "none" });
    expect(r.status).toBe("ok");
    expect(r.entities.find((e) => e.entity === "issues")?.pruned).toBe(1);
    expect(listIssues(t.db, { companyId: COMPANY_ID }).map((i) => i.identifier)).toEqual(["TST-1"]);

    // Stamp property itself: strictly greater than the newest stamp present, even when called back-to-back.
    const a = syncStamp(t.db);
    upsertIssue(t.db, live, a);
    const b = syncStamp(t.db);
    expect(Date.parse(b)).toBeGreaterThan(Date.parse(a));

    // Clock step-back: a stamp in the future must not stall; we step just past it.
    const future = new Date(Date.now() + 5_000).toISOString();
    upsertIssue(t.db, live, future);
    const c = syncStamp(t.db);
    expect(Date.parse(c)).toBe(Date.parse(future) + 1);
  });
});
