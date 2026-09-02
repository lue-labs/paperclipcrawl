/**
 * Strip anything that must never land in the shared SQLite file.
 *
 * Two layers:
 *  1. Known-sensitive fields per entity (adapterConfig, runtimeConfig, env, ...).
 *  2. A recursive sweep that replaces any value whose key looks like a secret.
 *
 * Both are conservative: a redacted field is replaced with the sentinel so a
 * reader can tell "removed" apart from "null upstream".
 */
export const REDACTED = "[redacted:paperclipcrawl]";

const AGENT_DROP = ["adapterConfig", "runtimeConfig", "permissions", "metadata"] as const;
const PROJECT_DROP = ["env", "codebase", "workspaces", "primaryWorkspace"] as const;
const ISSUE_DROP = ["assigneeAdapterOverrides", "executionWorkspaceSettings"] as const;
const COMPANY_DROP: readonly string[] = [];

const SECRET_KEY_RE = /(token|secret|password|passwd|api[_-]?key|apikey|private[_-]?key|credential|authorization|bearer|cookie)/i;
/** Keys that match SECRET_KEY_RE but are metadata, not secrets. */
const SECRET_KEY_ALLOW = new Set([
  "tokenName", "tokenId", "tokenCreatedAt", "apiKeyEnvVarName", "checkoutRunId",
  "credentialId", "hasCredential", "requiresCredential",
]);

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

function dropKeys<T extends Record<string, unknown>>(obj: T, keys: readonly string[]): T {
  const out: Record<string, unknown> = { ...obj };
  for (const k of keys) {
    if (k in out) out[k] = REDACTED;
  }
  return out as T;
}

export function sweepSecrets(value: unknown, depth = 0): unknown {
  if (depth > 32) return REDACTED;
  if (Array.isArray(value)) return value.map((v) => sweepSecrets(v, depth + 1));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (SECRET_KEY_RE.test(k) && !SECRET_KEY_ALLOW.has(k) && v !== null && v !== undefined && typeof v !== "object") {
        out[k] = REDACTED;
      } else if (SECRET_KEY_RE.test(k) && !SECRET_KEY_ALLOW.has(k) && v && typeof v === "object") {
        out[k] = REDACTED;
      } else {
        out[k] = sweepSecrets(v, depth + 1);
      }
    }
    return out;
  }
  return value as Json;
}

export function redactAgent<T extends Record<string, unknown>>(agent: T): T {
  return sweepSecrets(dropKeys(agent, AGENT_DROP)) as T;
}

export function redactProject<T extends Record<string, unknown>>(project: T): T {
  return sweepSecrets(dropKeys(project, PROJECT_DROP)) as T;
}

export function redactIssue<T extends Record<string, unknown>>(issue: T): T {
  return sweepSecrets(dropKeys(issue, ISSUE_DROP)) as T;
}

export function redactCompany<T extends Record<string, unknown>>(company: T): T {
  return sweepSecrets(dropKeys(company, COMPANY_DROP)) as T;
}

export function redactGeneric<T>(value: T): T {
  return sweepSecrets(value) as T;
}
