import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { migrate, openDb } from "../src/lib/db.ts";
import { upsertCompany, upsertIssue, putSyncState } from "../src/lib/store.ts";
import { COMPANY_ID, issue } from "./helpers.ts";

const CLI = path.join(import.meta.dir, "..", "src", "cli.ts");

function run(args: string[], env: Record<string, string> = {}): { code: number; out: string; err: string } {
  const p = Bun.spawnSync(["bun", "run", CLI, ...args], {
    env: {
      ...process.env, ...env,
      PAPERCLIP_HOME: env.PAPERCLIP_HOME ?? path.join(os.tmpdir(), "no-such-paperclip-home"),
      PAPERCLIP_CONTEXT: env.PAPERCLIP_CONTEXT ?? path.join(env.PAPERCLIP_HOME ?? path.join(os.tmpdir(), "no-such-paperclip-home"), "context.json"),
    },
    stdout: "pipe", stderr: "pipe",
  });
  return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() };
}

function seededDb(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "paperclipcrawl-cli-"));
  const dbPath = path.join(dir, "p.db");
  const db = openDb(dbPath, { create: true });
  migrate(db);
  const now = new Date().toISOString();
  upsertCompany(db, { id: COMPANY_ID, name: "Test Co", issuePrefix: "TST" }, "https://pc.example", now);
  upsertIssue(db, issue(1, { title: "Ledger export", status: "in_progress" }), now);
  upsertIssue(db, issue(2, { title: "Board sync", status: "done" }), now);
  putSyncState(db, { profile: "test", company_id: COMPANY_ID, entity: "issues", cursor: now, last_sync_at: now, last_status: "ok", last_count: 2 });
  db.close();
  return dbPath;
}

describe("cli (offline reads never touch the network)", () => {
  test("search / issue list / issue get / status work with an unreachable --api-base", () => {
    const dbPath = seededDb();
    const env = { PAPERCLIPCRAWL_DB: dbPath };
    const bad = ["--api-base", "http://127.0.0.1:9/"]; // port 9 (discard) — connection refused immediately

    const s = run(["search", "ledger", "--json", ...bad], env);
    expect(s.code).toBe(0);
    expect(JSON.parse(s.out).map((h: { identifier: string }) => h.identifier)).toEqual(["TST-1"]);

    const l = run(["issue", "list", "--status", "in_progress", "--json", ...bad], env);
    expect(l.code).toBe(0);
    expect(JSON.parse(l.out)).toHaveLength(1);

    const g = run(["issue", "get", "tst-2", "--json", ...bad], env);
    expect(g.code).toBe(0);
    expect(JSON.parse(g.out).identifier).toBe("TST-2");

    const st = run(["status", "--json", ...bad], env);
    expect(st.code).toBe(0);
    const j = JSON.parse(st.out);
    expect(j.schema_version).toBe("crawlkit.control.v1");
    expect(j.app_id).toBe("paperclipcrawl");
    expect(j.state).toBe("current");
    expect(j.counts.find((c: { id: string }) => c.id === "issues").value).toBe(2);
  });

  test("sql is read-only", () => {
    const dbPath = seededDb();
    const env = { PAPERCLIPCRAWL_DB: dbPath };
    const ok = run(["sql", "select identifier, status from issues order by identifier", "--json"], env);
    expect(ok.code).toBe(0);
    expect(JSON.parse(ok.out)).toEqual([{ identifier: "TST-1", status: "in_progress" }, { identifier: "TST-2", status: "done" }]);

    for (const bad of ["delete from issues", "update issues set status='done'", "insert into meta values('a','b')", "drop table issues", "pragma journal_mode=delete", "attach database '/tmp/x' as x"]) {
      const r = run(["sql", bad], env);
      expect(r.code).toBe(2);
    }
    // A write hidden behind a CTE is rejected by the connection itself.
    const sneaky = run(["sql", "with x as (select 1) insert into meta values('a','b')"], env);
    expect(sneaky.code).toBe(2);
    const after = run(["sql", "select count(*) as n from issues", "--json"], env);
    expect(JSON.parse(after.out)).toEqual([{ n: 2 }]);
  });

  test("missing db → clear exit codes; unknown command → 64", () => {
    const dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "paperclipcrawl-cli-")), "none.db");
    const env = { PAPERCLIPCRAWL_DB: dbPath };
    expect(run(["status"], env).code).toBe(1);
    expect(run(["search", "x"], env).code).toBe(3);
    expect(run(["frobnicate"], env).code).toBe(64);
    expect(run(["--help"], env).out).toContain("Usage: paperclipcrawl");
  });

  test("sync against unreachable API exits non-zero, records the error, and leaves prior data intact", () => {
    const dbPath = seededDb();
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "paperclipcrawl-home-"));
    fs.writeFileSync(path.join(home, "context.json"), JSON.stringify({ version: 2, currentProfile: "t", profiles: { t: { apiBase: "http://127.0.0.1:9", companyId: COMPANY_ID } } }));
    const env = { PAPERCLIPCRAWL_DB: dbPath, PAPERCLIP_HOME: home, PAPERCLIP_API_KEY: "dummy" };
    const r = run(["sync", "--json", "--retries", "0"], env);
    expect(r.code).not.toBe(0);
    const j = JSON.parse(r.out);
    expect(j.status).toBe("error");
    const l = run(["issue", "list", "--json"], env);
    expect(JSON.parse(l.out)).toHaveLength(2);
    const st = JSON.parse(run(["status", "--json"], env).out);
    expect(st.sync_state.some((s: { last_error: string | null }) => s.last_error)).toBe(true);
    // The dummy key must not have been persisted anywhere in the DB.
    const leak = run(["sql", "select count(*) as n from meta where value like '%dummy%'", "--json"], env);
    expect(JSON.parse(leak.out)).toEqual([{ n: 0 }]);
  });
});
