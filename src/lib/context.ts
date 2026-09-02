import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expandHome } from "./paths.ts";

/**
 * Mirrors paperclipai's client context + board auth resolution
 * (cli/src/client/context.ts, board-auth.ts, commands/client/common.ts) so
 * paperclipcrawl reuses the same profiles and stored credentials.
 *
 * The token is held in memory for the life of one process and is never
 * written anywhere by this tool.
 */

export interface Profile {
  apiBase?: string;
  companyId?: string;
  persona?: "board" | "agent";
  agentId?: string;
  agentName?: string;
  apiKeyEnvVarName?: string;
}

export interface ClientContext {
  path: string;
  exists: boolean;
  currentProfile: string;
  profiles: Record<string, Profile>;
}

export type AuthSource = "explicit" | "env" | "profile_env" | "stored_board" | "none";

export interface ResolvedTarget {
  profileName: string;
  apiBase: string;
  companyId: string | null;
  apiKey: string | undefined;
  authSource: AuthSource;
}

export function paperclipHomeDir(env = process.env): string {
  const raw = env.PAPERCLIP_HOME?.trim();
  if (raw) return path.resolve(expandHome(raw));
  return path.resolve(os.homedir(), ".paperclip");
}

function findContextFromAncestors(startDir: string): string | null {
  let dir = path.resolve(startDir);
  for (;;) {
    const candidate = path.join(dir, ".paperclip", "context.json");
    if (fs.existsSync(candidate)) return candidate;
    const next = path.dirname(dir);
    if (next === dir) return null;
    dir = next;
  }
}

export function resolveContextPath(override?: string, env = process.env): string {
  if (override?.trim()) return path.resolve(expandHome(override.trim()));
  if (env.PAPERCLIP_CONTEXT?.trim()) return path.resolve(expandHome(env.PAPERCLIP_CONTEXT.trim()));
  return findContextFromAncestors(process.cwd()) ?? path.join(paperclipHomeDir(env), "context.json");
}

export function resolveAuthStorePath(env = process.env): string {
  if (env.PAPERCLIP_AUTH_STORE?.trim()) return path.resolve(expandHome(env.PAPERCLIP_AUTH_STORE.trim()));
  return path.join(paperclipHomeDir(env), "auth.json");
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim().length > 0 ? v.trim() : undefined;
}

export function readContext(override?: string, env = process.env): ClientContext {
  const filePath = resolveContextPath(override, env);
  if (!fs.existsSync(filePath)) {
    return { path: filePath, exists: false, currentProfile: "default", profiles: { default: {} } };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (err) {
    throw new Error(`Failed to parse ${filePath}: ${err instanceof Error ? err.message : String(err)}`);
  }
  const rec = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const currentProfile = str(rec.currentProfile) ?? "default";
  const profiles: Record<string, Profile> = {};
  const rawProfiles = rec.profiles;
  if (rawProfiles && typeof rawProfiles === "object" && !Array.isArray(rawProfiles)) {
    for (const [name, p] of Object.entries(rawProfiles as Record<string, unknown>)) {
      if (!name.trim() || !p || typeof p !== "object") continue;
      const pr = p as Record<string, unknown>;
      profiles[name] = {
        apiBase: str(pr.apiBase),
        companyId: str(pr.companyId),
        persona: pr.persona === "board" || pr.persona === "agent" ? pr.persona : undefined,
        agentId: str(pr.agentId),
        agentName: str(pr.agentName),
        apiKeyEnvVarName: str(pr.apiKeyEnvVarName),
      };
    }
  }
  if (!profiles[currentProfile]) profiles[currentProfile] = {};
  return { path: filePath, exists: true, currentProfile, profiles };
}

export function normalizeApiBase(apiBase: string): string {
  return apiBase.trim().replace(/\/+$/, "");
}

/** Read the board credential for an apiBase from ~/.paperclip/auth.json. Never logged. */
export function storedBoardToken(apiBase: string, env = process.env): string | undefined {
  const storePath = resolveAuthStorePath(env);
  if (!fs.existsSync(storePath)) return undefined;
  try {
    const raw = JSON.parse(fs.readFileSync(storePath, "utf8")) as { credentials?: Record<string, { token?: unknown; apiBase?: unknown }> };
    const creds = raw?.credentials ?? {};
    const want = normalizeApiBase(apiBase);
    for (const [key, cred] of Object.entries(creds)) {
      if (normalizeApiBase(key) === want || (typeof cred?.apiBase === "string" && normalizeApiBase(cred.apiBase) === want)) {
        return str(cred?.token);
      }
    }
  } catch {
    return undefined;
  }
  return undefined;
}

export interface ResolveOptions {
  contextPath?: string;
  profile?: string;
  apiBase?: string;
  apiKey?: string;
  companyId?: string;
}

/**
 * Resolve one profile into a target. Order matches paperclipai:
 *   apiBase   : --api-base > PAPERCLIP_API_URL > profile.apiBase > http://localhost:3100
 *   apiKey    : --api-key  > PAPERCLIP_API_KEY > $profile.apiKeyEnvVarName > auth.json[apiBase].token
 *   companyId : --company-id > PAPERCLIP_COMPANY_ID > profile.companyId
 */
export function resolveTarget(ctx: ClientContext, opts: ResolveOptions = {}, env = process.env): ResolvedTarget {
  const profileName = opts.profile?.trim() || ctx.currentProfile;
  const profile = ctx.profiles[profileName];
  if (!profile && opts.profile) {
    throw new Error(`Unknown profile '${profileName}' in ${ctx.path}. Known: ${Object.keys(ctx.profiles).join(", ")}`);
  }
  const p = profile ?? {};
  const apiBase = normalizeApiBase(
    opts.apiBase?.trim() || env.PAPERCLIP_API_URL?.trim() || p.apiBase || "http://localhost:3100",
  );

  let apiKey: string | undefined;
  let authSource: AuthSource = "none";
  if (opts.apiKey?.trim()) {
    apiKey = opts.apiKey.trim();
    authSource = "explicit";
  } else if (env.PAPERCLIP_API_KEY?.trim()) {
    apiKey = env.PAPERCLIP_API_KEY.trim();
    authSource = "env";
  } else if (p.apiKeyEnvVarName && env[p.apiKeyEnvVarName]?.trim()) {
    apiKey = env[p.apiKeyEnvVarName]!.trim();
    authSource = "profile_env";
  } else {
    const stored = storedBoardToken(apiBase, env);
    if (stored) {
      apiKey = stored;
      authSource = "stored_board";
    }
  }

  const companyId = opts.companyId?.trim() || env.PAPERCLIP_COMPANY_ID?.trim() || p.companyId || null;
  return { profileName, apiBase, companyId, apiKey, authSource };
}

/** All profiles that have a companyId, deduped by (apiBase, companyId). */
export function resolveAllTargets(ctx: ClientContext, opts: Omit<ResolveOptions, "profile" | "companyId"> = {}, env = process.env): ResolvedTarget[] {
  const seen = new Set<string>();
  const out: ResolvedTarget[] = [];
  for (const name of Object.keys(ctx.profiles)) {
    const t = resolveTarget(ctx, { ...opts, profile: name }, env);
    if (!t.companyId) continue;
    const key = `${t.apiBase}::${t.companyId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(t);
  }
  return out;
}
