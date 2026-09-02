# Design: Paperclip offline SQLite mirror (`paperclipcrawl`)

Condensed from `~/Projects/personal/agent-system/designs/paperclip-offline-sqlite-cache.md`
(proposed 2026-09-02). This copy records what v1 actually shipped; the source doc keeps
the investigation trail and the "later / full parity" roadmap.

Analogues: `gitcrawl` / `discrawl` / `slacrawl` / `imsgcrawl` / `notcrawl` (OpenClaw crawl family).
Non-analogue: `ghx` (short-TTL in-memory response cache — a different job).

## Problem

Agents talk to Paperclip only through live HTTP via `paperclipai`. There is no entity cache.
When `paperclip.bermont.digital` is down (observed 503 on 2026-09-02 `whoami`/`health`),
board review, inbox triage and cross-agent coordination stall.

The crawl family already solved this shape for GitHub/Discord/Slack/iMessage/Notion:
mirror into local SQLite, share one DB per host across agents, query offline, sync when online.

## Decision: sibling `paperclipcrawl`, not a `paperclipai` rewrite

`paperclipai` stays the live API + instance/ops CLI and the **only** mutation path.
`paperclipcrawl` is a small crawl-shaped tool that:

- reuses Paperclip auth via the existing context/profiles (`~/.paperclip/context.json`,
  `~/.paperclip/auth.json`, `PAPERCLIP_*` env) — never prints or stores secrets;
- calls the same GET routes `paperclipai issue|company|approval|agent|project` use;
- writes a shared SQLite archive agents can `search` / `issue list` / `sql` when the API is
  503 or rate-limited.

Read path → `paperclipcrawl`. Write path → `paperclipai`. The API client is GET-only by
construction (`src/lib/api.ts`), so write-back is impossible, not just disallowed.

## DB location (shared across agents on one host)

| OS | Path |
|---|---|
| macOS | `~/Library/Application Support/paperclipcrawl/paperclipcrawl.db` |
| Linux | `${XDG_DATA_HOME:-~/.local/share}/paperclipcrawl/paperclipcrawl.db` |
| Override | `--db PATH` / `PAPERCLIPCRAWL_DB` |

Dir `0700`, DB `0600`. WAL journal; `busy_timeout` 5 s. All agents under the same OS user share
the file. One DB for all profiles: every entity row carries `company_id`.

Avoids colliding with the Electron app dir `~/Library/Application Support/Paperclip` (capital P).

## Schema (v1)

| Table | Source route | Notes |
|---|---|---|
| `companies` | `GET /api/companies/:id` (403 → `GET /api/companies`) | id, name, issue_prefix, status, api_base, raw_json |
| `issues` | `GET /api/companies/:id/issues` | identifier, status, priority, title, description, assignee, timestamps, `comments_synced_at`, raw_json |
| `comments` | `GET /api/issues/:id/comments` | author, body, created_at, raw_json |
| `approvals` | `GET /api/companies/:id/approvals` | server-redacted payload |
| `agents` | `GET /api/companies/:id/agents` | directory for assignee names; `adapterConfig`/`runtimeConfig`/`permissions`/`metadata` replaced by a sentinel |
| `projects` | `GET /api/companies/:id/projects` | `env`/`codebase`/`workspaces` replaced by a sentinel |
| `sync_state` | internal | cursor + last status per `(profile, company_id, entity)` |
| `sync_runs` | internal | one row per `sync` invocation |
| `meta` | internal | schema_version, app_id, last_sync_at |

FTS5 external-content indexes: `issues_fts(identifier, title, description)` and
`comments_fts(body)` kept in step by triggers. Indexes on `(company_id, status)`,
`(company_id, updated_at desc)`, `(identifier)`.

Every `raw_json` passes through `src/lib/redact.ts` at write time: known secret-bearing
sub-objects are dropped, then a recursive key-pattern sweep (`token|secret|apiKey|password|…`)
redacts anything that slipped through. `doctor` scans the DB for the resolved bearer token
bytes and fails if found.

## Sync algorithm

Per target company (current profile, `--profile`, or `--all` deduped by `apiBase::companyId`):

1. Company record (fallback to list on 403). Failure here aborts the company early.
2. `agents`, `projects`, `approvals`: full list → upsert → prune rows with `synced_at < runStart`.
3. Issues, paginated `sortField=updated&sortDir=desc&limit=500`:
   - **full** (first run, `--full`): every page, then prune rows not seen this run;
   - **incremental**: stop paging once a page's oldest `updatedAt` predates the stored cursor
     (`max(updatedAt)` seen); never prunes. `--since ISO` overrides the cursor.
4. Comments: for changed issues **plus** all issues in an active status
   (`todo|in_progress|in_review|blocked`, whose threads can move without bumping the issue),
   fetch the thread (`order=asc&limit=500&afterCommentId`), replace atomically. `--full` or
   `--comments all` hydrates every thread; `--comments none` skips.
5. Errors are recorded per entity in `sync_state.last_error`; existing data is never dropped
   on failure. Exit 0 ok / 2 partial / 1 error / 75 lock held.

Singleflight: `.paperclipcrawl-sync.lock` next to the DB, `O_EXCL`, JSON `{pid, host,
startedAt, argv}`, stolen when the pid is dead on this host or the lock is > 1 h old.

`sync --if-stale 5m` is a no-op when the last successful sync is younger than the duration.

## Commands (v1)

```text
paperclipcrawl init
paperclipcrawl doctor [--json]
paperclipcrawl status [--json]                 # crawlkit.control.v1 control surface
paperclipcrawl sync [--profile NAME|--all] [--company-id ID] [--since ISO] [--full] [--if-stale 5m]
paperclipcrawl sync issue <idOrIdentifier>     # deep hydrate one issue + comments
paperclipcrawl search <query> [--company-id] [--status] [--with-comments] [--json]
paperclipcrawl issue list|get …                # offline mirrors of common reads
paperclipcrawl sql 'select …'                  # read-only (readonly handle + query_only + prefix check)
paperclipcrawl maintain [--vacuum]
```

Out of v1: write-back, checkout/release, approval mutations, `watch` daemon, documents,
attachments, activity/heartbeat runs, cross-machine share.

## Multi-agent / multi-machine

| Concern | Approach |
|---|---|
| Many agents, one Mac | Single user-owned DB; WAL; singleflight lock |
| Mac vs lue-kube pods | Pods keep the live in-cluster API; Mac/Mini get the mirror for offline / 503 resilience |
| Cross-machine share | Deferred (git share or rsync artifact later) |
| Staleness | `status` reports `state: current|stale|empty` (default 30 min, `PAPERCLIPCRAWL_STALE_AFTER_MS`); read commands hint on stderr |

## Decision log

- 2026-09-02: Proposed sibling crawl tool (design doc).
- 2026-09-02: v1 shipped in TypeScript on Bun (`bun build --compile` → single arm64 binary).
  Go deferred until it earns its keep. API supports offset pagination sorted by `updated`,
  which is enough for the cursor scheme above — no server change needed.
