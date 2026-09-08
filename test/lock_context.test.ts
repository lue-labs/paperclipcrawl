import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { acquireLock, isStale, LockHeldError, readLock, STALE_AFTER_MS } from "../src/lib/lock.ts";
import { readContext, resolveAllTargets, resolveTarget, storedBoardToken } from "../src/lib/context.ts";
import { defaultDataDir, resolveDbPath } from "../src/lib/paths.ts";

function tmpdir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "paperclipcrawl-lc-"));
}

describe("lock", () => {
  test("singleflight: second acquire fails while held; released lock can be re-taken", () => {
    const p = path.join(tmpdir(), "x.lock");
    const l1 = acquireLock(p, ["sync"]);
    expect(readLock(p)?.pid).toBe(process.pid);
    expect(() => acquireLock(p)).toThrow(LockHeldError);
    l1.release();
    expect(fs.existsSync(p)).toBe(false);
    const l2 = acquireLock(p);
    l2.release();
  });

  test("stale lock (dead pid or too old) is stolen", () => {
    const p = path.join(tmpdir(), "x.lock");
    fs.writeFileSync(p, JSON.stringify({ pid: 999_999_9, host: os.hostname(), startedAt: new Date().toISOString(), argv: [] }));
    expect(isStale(readLock(p))).toBe(true);
    const l = acquireLock(p);
    expect(readLock(p)?.pid).toBe(process.pid);
    l.release();

    fs.writeFileSync(p, JSON.stringify({ pid: process.pid, host: os.hostname(), startedAt: new Date(Date.now() - STALE_AFTER_MS - 1000).toISOString(), argv: [] }));
    expect(isStale(readLock(p))).toBe(true);
    fs.writeFileSync(p, JSON.stringify({ pid: process.pid, host: os.hostname(), startedAt: new Date().toISOString(), argv: [] }));
    expect(isStale(readLock(p))).toBe(false);
  });
});

describe("context + auth resolution (mirrors paperclipai)", () => {
  const home = tmpdir();
  const pcDir = path.join(home, ".paperclip");
  fs.mkdirSync(pcDir, { recursive: true });
  fs.writeFileSync(path.join(pcDir, "context.json"), JSON.stringify({
    version: 2, currentProfile: "a",
    profiles: {
      a: { apiBase: "https://pc.example/", companyId: "co-a" },
      b: { apiBase: "https://pc.example", companyId: "co-b", apiKeyEnvVarName: "B_KEY" },
      c: { apiBase: "https://pc.example", companyId: "co-a" }, // dup of a's target
      d: { apiBase: "https://other.example" }, // no company
    },
  }));
  fs.writeFileSync(path.join(pcDir, "auth.json"), JSON.stringify({ version: 1, credentials: { "https://pc.example": { token: "board-token-XYZ" } } }));
  // PAPERCLIP_CONTEXT beats the cwd-ancestor walk (which would otherwise find the developer's real ~/.paperclip).
  const env = { HOME: home, PAPERCLIP_HOME: pcDir, PAPERCLIP_CONTEXT: path.join(pcDir, "context.json") } as NodeJS.ProcessEnv;

  test("profile/apiBase/companyId/apiKey precedence and auth source labelling", () => {
    const ctx = readContext(undefined, env);
    expect(ctx.exists).toBe(true);
    const a = resolveTarget(ctx, {}, env);
    expect(a).toMatchObject({ profileName: "a", apiBase: "https://pc.example", companyId: "co-a", authSource: "stored_board", apiKey: "board-token-XYZ" });

    const b = resolveTarget(ctx, { profile: "b" }, { ...env, B_KEY: "from-profile-env" });
    expect(b).toMatchObject({ authSource: "profile_env", apiKey: "from-profile-env" });

    const e = resolveTarget(ctx, { profile: "b" }, { ...env, PAPERCLIP_API_KEY: "from-env", B_KEY: "x" });
    expect(e).toMatchObject({ authSource: "env", apiKey: "from-env" });

    const x = resolveTarget(ctx, { apiKey: "explicit", apiBase: "https://override.example", companyId: "co-z" }, env);
    expect(x).toMatchObject({ authSource: "explicit", apiKey: "explicit", apiBase: "https://override.example", companyId: "co-z" });

    const d = resolveTarget(ctx, { profile: "d" }, env);
    expect(d.authSource).toBe("none");
    expect(d.companyId).toBeNull();

    expect(() => resolveTarget(ctx, { profile: "nope" }, env)).toThrow(/nope/);
    expect(storedBoardToken("https://pc.example/", env)).toBe("board-token-XYZ");
  });

  test("--all dedupes identical apiBase::companyId targets and skips profiles without companyId", () => {
    const ctx = readContext(undefined, env);
    const all = resolveAllTargets(ctx, {}, env);
    expect(all.map((t) => `${t.profileName}:${t.companyId}`).sort()).toEqual(["a:co-a", "b:co-b"]);
  });

  test("db path precedence: --db > PAPERCLIPCRAWL_DB > platform default", () => {
    expect(resolveDbPath("/x/y.db", {})).toBe("/x/y.db");
    expect(resolveDbPath(undefined, { PAPERCLIPCRAWL_DB: "/e/f.db" })).toBe("/e/f.db");
    expect(defaultDataDir("darwin", { HOME: "/Users/t" })).toBe("/Users/t/Library/Application Support/paperclipcrawl");
    expect(defaultDataDir("linux", { HOME: "/home/t" })).toBe("/home/t/.local/share/paperclipcrawl");
    expect(defaultDataDir("linux", { HOME: "/home/t", XDG_DATA_HOME: "/data" })).toBe("/data/paperclipcrawl");
  });
});
