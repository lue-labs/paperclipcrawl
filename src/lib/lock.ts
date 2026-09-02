import fs from "node:fs";
import os from "node:os";

/**
 * Singleflight sync lock (discrawl `.discrawl-sync.lock` pattern).
 * O_EXCL create; contents = JSON {pid, host, startedAt, argv}. A lock is stale
 * when its pid is dead on this host or it is older than STALE_AFTER_MS.
 */
export const STALE_AFTER_MS = 60 * 60 * 1000;

export interface LockInfo {
  pid: number;
  host: string;
  startedAt: string;
  argv: string[];
}

export class LockHeldError extends Error {
  constructor(public readonly lockPath: string, public readonly holder: LockInfo | null) {
    super(
      holder
        ? `Another sync is running (pid ${holder.pid} on ${holder.host}, started ${holder.startedAt}). Lock: ${lockPath}`
        : `Another sync holds the lock: ${lockPath}`,
    );
  }
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

export function readLock(lockPath: string): LockInfo | null {
  try {
    const raw = fs.readFileSync(lockPath, "utf8");
    const parsed = JSON.parse(raw) as Partial<LockInfo>;
    if (typeof parsed.pid !== "number") return null;
    return {
      pid: parsed.pid,
      host: String(parsed.host ?? ""),
      startedAt: String(parsed.startedAt ?? ""),
      argv: Array.isArray(parsed.argv) ? parsed.argv.map(String) : [],
    };
  } catch {
    return null;
  }
}

export function isStale(info: LockInfo | null, now = Date.now()): boolean {
  if (!info) return true;
  const started = Date.parse(info.startedAt);
  if (Number.isFinite(started) && now - started > STALE_AFTER_MS) return true;
  if (info.host === os.hostname() && !pidAlive(info.pid)) return true;
  return false;
}

export interface Lock {
  path: string;
  release(): void;
}

export function acquireLock(lockPath: string, argv: string[] = process.argv.slice(2)): Lock {
  const payload: LockInfo = { pid: process.pid, host: os.hostname(), startedAt: new Date().toISOString(), argv };
  const write = () => {
    const fd = fs.openSync(lockPath, "wx", 0o600);
    try {
      fs.writeSync(fd, JSON.stringify(payload));
    } finally {
      fs.closeSync(fd);
    }
  };

  try {
    write();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    const holder = readLock(lockPath);
    if (!isStale(holder)) throw new LockHeldError(lockPath, holder);
    // Stale: steal it.
    try { fs.unlinkSync(lockPath); } catch { /* raced */ }
    write();
  }

  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    try {
      const current = readLock(lockPath);
      if (current && current.pid === process.pid) fs.unlinkSync(lockPath);
    } catch { /* already gone */ }
  };
  process.once("exit", release);
  return { path: lockPath, release };
}
