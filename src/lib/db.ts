import { Database } from "bun:sqlite";
import fs from "node:fs";
import path from "node:path";
import { SCHEMA_SQL, SCHEMA_VERSION, ENTITY_TABLES, type EntityTable } from "./schema.ts";

export interface OpenOptions {
  /** Open read-only; fails if the file does not exist. */
  readonly?: boolean;
  /** Create the data dir (0700) and file (0600) if missing. */
  create?: boolean;
}

export class DbMissingError extends Error {
  constructor(public readonly dbPath: string) {
    super(`No paperclipcrawl database at ${dbPath}. Run: paperclipcrawl init && paperclipcrawl sync`);
  }
}

export function dbExists(dbPath: string): boolean {
  return fs.existsSync(dbPath);
}

/** Open the mirror DB. WAL mode so many agent readers never block a sync writer. */
export function openDb(dbPath: string, opts: OpenOptions = {}): Database {
  const exists = fs.existsSync(dbPath);
  if (!exists && !opts.create) throw new DbMissingError(dbPath);

  if (!exists) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true, mode: 0o700 });
    try { fs.chmodSync(path.dirname(dbPath), 0o700); } catch { /* best effort */ }
  }

  const db = new Database(dbPath, opts.readonly ? { readonly: true } : { create: true });
  if (opts.readonly) {
    db.exec("PRAGMA query_only = 1;");
  } else {
    db.exec("PRAGMA journal_mode = WAL;");
    db.exec("PRAGMA synchronous = NORMAL;");
    if (!exists) {
      try { fs.chmodSync(dbPath, 0o600); } catch { /* best effort */ }
    }
  }
  db.exec("PRAGMA busy_timeout = 5000;");
  db.exec("PRAGMA foreign_keys = ON;");
  return db;
}

export function currentSchemaVersion(db: Database): number {
  const hasMeta = db
    .query<{ n: number }, []>("SELECT count(*) AS n FROM sqlite_master WHERE type='table' AND name='meta'")
    .get();
  if (!hasMeta || hasMeta.n === 0) return 0;
  const row = db.query<{ value: string }, []>("SELECT value FROM meta WHERE key='schema_version'").get();
  return row ? Number(row.value) || 0 : 0;
}

/** Apply schema (idempotent). Refuses to open a DB written by a newer schema. */
export function migrate(db: Database): { from: number; to: number } {
  const from = currentSchemaVersion(db);
  if (from > SCHEMA_VERSION) {
    throw new Error(
      `Database schema version ${from} is newer than this binary supports (${SCHEMA_VERSION}). Upgrade paperclipcrawl.`,
    );
  }
  db.exec(SCHEMA_SQL);
  db.query("INSERT INTO meta(key, value) VALUES ('schema_version', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
    .run(String(SCHEMA_VERSION));
  if (from === 0) {
    setMeta(db, "created_at", new Date().toISOString());
  }
  return { from, to: SCHEMA_VERSION };
}

export function getMeta(db: Database, key: string): string | null {
  const row = db.query<{ value: string }, [string]>("SELECT value FROM meta WHERE key=?").get(key);
  return row?.value ?? null;
}

export function setMeta(db: Database, key: string, value: string): void {
  db.query("INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(key, value);
}

export function tableCounts(db: Database): Record<EntityTable, number> {
  const out = {} as Record<EntityTable, number>;
  for (const t of ENTITY_TABLES) {
    const row = db.query<{ n: number }, []>(`SELECT count(*) AS n FROM ${t}`).get();
    out[t] = row?.n ?? 0;
  }
  return out;
}

export function journalMode(db: Database): string {
  const row = db.query<{ journal_mode: string }, []>("PRAGMA journal_mode").get();
  return row?.journal_mode ?? "unknown";
}

export function hasFts5(db: Database): boolean {
  try {
    const rows = db.query<{ compile_options: string }, []>("PRAGMA compile_options").all();
    if (rows.some((r) => /ENABLE_FTS5/i.test(r.compile_options))) return true;
    // Bun's bundled SQLite may not report compile options; probe instead.
    const probe = new Database(":memory:");
    try {
      probe.exec("CREATE VIRTUAL TABLE t USING fts5(a)");
      return true;
    } finally {
      probe.close();
    }
  } catch {
    return false;
  }
}

export function sqliteVersion(db: Database): string {
  const row = db.query<{ v: string }, []>("SELECT sqlite_version() AS v").get();
  return row?.v ?? "unknown";
}

/** Rebuild FTS indexes from content tables (after VACUUM or if triggers ever drift). */
export function rebuildFts(db: Database): void {
  db.exec("INSERT INTO issues_fts(issues_fts) VALUES('rebuild');");
  db.exec("INSERT INTO comments_fts(comments_fts) VALUES('rebuild');");
}
