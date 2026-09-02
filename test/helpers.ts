import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Database } from "bun:sqlite";
import { migrate, openDb } from "../src/lib/db.ts";
import { ApiRequestError, type PaperclipReader } from "../src/lib/api.ts";
import type { ResolvedTarget } from "../src/lib/context.ts";

export function tmpDb(): { dir: string; dbPath: string; db: Database; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "paperclipcrawl-test-"));
  const dbPath = path.join(dir, "test.db");
  const db = openDb(dbPath, { create: true });
  migrate(db);
  return { dir, dbPath, db, cleanup: () => { try { db.close(); } catch {} fs.rmSync(dir, { recursive: true, force: true }); } };
}

export const COMPANY_ID = "11111111-1111-4111-8111-111111111111";
export const TARGET: ResolvedTarget = {
  profileName: "test", apiBase: "http://stub.invalid", companyId: COMPANY_ID, apiKey: "pcp_test_token_do_not_persist_0123456789", authSource: "explicit",
};

export function issue(n: number, over: Record<string, unknown> = {}): Record<string, unknown> {
  const t = new Date(Date.UTC(2026, 0, 1, 0, n)).toISOString();
  return {
    id: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`, companyId: COMPANY_ID, projectId: null, goalId: null, parentId: null,
    title: `Issue ${n} ledger sync`, description: `Body of issue ${n}`, status: "todo", priority: "medium",
    assigneeAgentId: null, assigneeUserId: null, identifier: `TST-${n}`, createdAt: t, updatedAt: t, completedAt: null,
    assigneeAdapterOverrides: { apiKey: "SHOULD_NOT_PERSIST" },
    ...over,
  };
}

export function comment(issueId: string, n: number, body = `comment ${n}`): Record<string, unknown> {
  return { id: `c-${issueId}-${n}`, companyId: COMPANY_ID, issueId, authorType: "agent", authorAgentId: "agent-1", authorUserId: null, body, createdAt: new Date(Date.UTC(2026, 0, 2, 0, n)).toISOString() };
}

export interface StubData {
  company?: Record<string, unknown> | null;
  issues: Record<string, unknown>[];
  comments: Record<string, Record<string, unknown>[]>;
  agents?: Record<string, unknown>[];
  projects?: Record<string, unknown>[];
  approvals?: Record<string, unknown>[];
  failCompany?: number;
}

/** In-memory PaperclipReader honouring the server's pagination contract closely enough for the engine. */
export class StubReader implements PaperclipReader {
  calls: string[] = [];
  constructor(public data: StubData) {}

  async get<T>(p: string): Promise<T> {
    this.calls.push(p);
    const [pathname, qs] = p.split("?");
    const q = new URLSearchParams(qs ?? "");
    const m = (re: RegExp) => re.exec(pathname ?? "");
    let r: RegExpExecArray | null;
    if (this.data.failCompany && (r = m(/^\/api\/companies\/([^/]+)$/))) throw new ApiRequestError(this.data.failCompany, `HTTP ${this.data.failCompany}`, p);
    if (pathname === "/api/companies") return [this.data.company ?? { id: COMPANY_ID, name: "Test Co", issuePrefix: "TST" }] as T;
    if ((r = m(/^\/api\/companies\/([^/]+)$/))) return (this.data.company ?? { id: r[1], name: "Test Co", issuePrefix: "TST" }) as T;
    if ((r = m(/^\/api\/companies\/([^/]+)\/agents$/))) return (this.data.agents ?? []) as T;
    if ((r = m(/^\/api\/companies\/([^/]+)\/projects$/))) return (this.data.projects ?? []) as T;
    if ((r = m(/^\/api\/companies\/([^/]+)\/approvals$/))) return (this.data.approvals ?? []) as T;
    if ((r = m(/^\/api\/companies\/([^/]+)\/issues$/))) {
      const limit = Number(q.get("limit") ?? 500);
      const offset = Number(q.get("offset") ?? 0);
      const dir = q.get("sortDir") === "asc" ? 1 : -1;
      const sorted = [...this.data.issues].sort((a, b) => dir * (Date.parse(String(a.updatedAt)) - Date.parse(String(b.updatedAt))));
      return sorted.slice(offset, offset + limit) as T;
    }
    if ((r = m(/^\/api\/issues\/([^/]+)\/comments$/))) {
      const all = this.data.comments[r[1]!] ?? [];
      const after = q.get("afterCommentId");
      const limit = Number(q.get("limit") ?? 500);
      const start = after ? all.findIndex((c) => c.id === after) + 1 : 0;
      return all.slice(start, start + limit) as T;
    }
    if ((r = m(/^\/api\/issues\/([^/]+)$/))) {
      const key = r[1]!;
      const found = this.data.issues.find((i) => i.id === key || i.identifier === key);
      if (!found) throw new ApiRequestError(404, "Not found", p);
      return found as T;
    }
    throw new ApiRequestError(404, `stub: no route for ${p}`, p);
  }
}
