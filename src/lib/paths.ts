import os from "node:os";
import path from "node:path";

export const APP_ID = "paperclipcrawl";
export const DB_BASENAME = "paperclipcrawl.db";
export const LOCK_BASENAME = ".paperclipcrawl-sync.lock";

/**
 * Default data directory shared by every agent under this OS user.
 *   macOS : ~/Library/Application Support/paperclipcrawl
 *   other : ${XDG_DATA_HOME:-~/.local/share}/paperclipcrawl
 */
export function defaultDataDir(platform: NodeJS.Platform = process.platform, env = process.env): string {
  const home = env.HOME?.trim() || os.homedir();
  if (platform === "darwin") {
    return path.join(home, "Library", "Application Support", APP_ID);
  }
  const xdg = env.XDG_DATA_HOME?.trim();
  return path.join(xdg && xdg.length > 0 ? xdg : path.join(home, ".local", "share"), APP_ID);
}

/** Resolve the DB path: --db flag > PAPERCLIPCRAWL_DB > platform default. */
export function resolveDbPath(override?: string, env = process.env): string {
  const raw = override?.trim() || env.PAPERCLIPCRAWL_DB?.trim();
  if (raw) return path.resolve(expandHome(raw));
  return path.join(defaultDataDir(process.platform, env), DB_BASENAME);
}

export function dataDirForDb(dbPath: string): string {
  return path.dirname(dbPath);
}

export function lockPathForDb(dbPath: string): string {
  return path.join(dataDirForDb(dbPath), LOCK_BASENAME);
}

export function expandHome(p: string): string {
  if (p === "~") return os.homedir();
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
  return p;
}
