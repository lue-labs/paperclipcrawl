# paperclipcrawl

> **leo-labs** — brand name (Leonardo + leopard). GitHub org slug is still [`lue-labs`](https://github.com/lue-labs) until rename to **`leo-labs-ai`**. This change does not retarget npm `@lue-labs/*`, `ghcr.io/lue-labs/*`, or clone URLs. Decision `leo-labs-rename-20261003`.


Offline SQLite mirror for [Paperclip](https://github.com/paperclipai/paperclip) — the
crawl-family sibling (`gitcrawl` / `discrawl` / `slacrawl`) for board data.

- **Read path** when the API is down, slow, or rate-limited: `search`, `issue list|get`, `sql`.
- **Never a write path.** Mutations stay on `paperclipai`; the client here is GET-only.
- **No secrets in SQLite.** Reuses `paperclipai` auth files in memory only; agent adapter
  configs, project env, and anything key-shaped are redacted before write. `doctor` verifies.

Design: [`docs/design.md`](docs/design.md) (source of truth:
`~/Projects/personal/agent-system/designs/paperclip-offline-sqlite-cache.md`).

## Quick start

```sh
paperclipcrawl init                 # creates ~/Library/Application Support/paperclipcrawl/paperclipcrawl.db
paperclipcrawl doctor               # paths, WAL, FTS5, auth source, no-secrets scan
paperclipcrawl sync --all           # every profile in ~/.paperclip/context.json
paperclipcrawl status               # counts, per-company freshness, last errors

paperclipcrawl search "sync lock" --with-comments
paperclipcrawl issue list --status in_progress,blocked
paperclipcrawl issue get CCS-12
paperclipcrawl sql "select identifier, status, title from issues where status='blocked' order by updated_at desc"
```

`sync` uses the current profile by default; `--profile NAME`, `--company-id ID`, or `--all`
select others. Incremental after the first run (cursor on `updatedAt`); `--full` re-lists and
prunes; `--since ISO` bounds a pull; `--if-stale 5m` makes it a cheap no-op when fresh.
`sync issue <id|IDENTIFIER>` deep-hydrates one thread.

Read commands never touch the network. They print a one-line stderr hint when the mirror is
older than 30 min (`PAPERCLIPCRAWL_STALE_AFTER_MS` to tune).

## Auth and profiles

Resolution mirrors `paperclipai` exactly, so no new configuration:

| Value | Order |
|---|---|
| API base | `--api-base` → `PAPERCLIP_API_URL` → profile `apiBase` → `http://localhost:3100` |
| Company | `--company-id` → `PAPERCLIP_COMPANY_ID` → profile `companyId` |
| Token | `--api-key` → `PAPERCLIP_API_KEY` → profile `apiKeyEnvVarName` → `~/.paperclip/auth.json[apiBase].token` |
| Context file | `--context` → `PAPERCLIP_CONTEXT` → nearest ancestor `.paperclip/context.json` → `$PAPERCLIP_HOME/context.json` |

`doctor` reports only the *source kind* (`stored_board`, `env`, …), never the token.

## Data location

| OS | Path |
|---|---|
| macOS | `~/Library/Application Support/paperclipcrawl/paperclipcrawl.db` |
| Linux | `${XDG_DATA_HOME:-~/.local/share}/paperclipcrawl/paperclipcrawl.db` |
| Override | `--db PATH` or `PAPERCLIPCRAWL_DB` |

Dir `0700`, DB `0600`, WAL journal. Shared by every agent running as the same user; concurrent
`sync` invocations are serialised by `.paperclipcrawl-sync.lock` (stale locks are reclaimed).

## Exit codes

| Code | Meaning |
|---|---|
| 0 | ok |
| 1 | error (sync fully failed, doctor failed, status on missing DB) |
| 2 | partial sync / rejected SQL |
| 3 | not in mirror (missing DB or unknown issue) |
| 64 | usage |
| 75 | sync lock held by another process |

## Install

**New devices and agents:** follow [Device and agent onboarding](docs/onboarding.md)
for source transfer, PATH, authentication, skill discovery, and acceptance checks.
Source: https://github.com/lue-labs/paperclipcrawl. Build from source; no binary release is published yet.

Requires [Bun](https://bun.sh) ≥ 1.3 to build; the result is a self-contained binary (no
runtime deps).

```sh
git clone --branch lue/paperclip-offline-cache https://github.com/lue-labs/paperclipcrawl.git ~/Projects/personal/paperclipcrawl
cd ~/Projects/personal/paperclipcrawl
bun install
bun test
bun run build              # → dist/paperclipcrawl
bun run install:local      # → ~/.local/bin/paperclipcrawl (PAPERCLIPCRAWL_INSTALL_DIR to change)
paperclipcrawl doctor
```

Upgrade: `git pull --ff-only && bun run install:local`.

### m2-max (lukes-macbook-pro) — done 2026-09-02

- Binary: `~/.local/bin/paperclipcrawl` (arm64, built from this branch).
- DB: `~/Library/Application Support/paperclipcrawl/paperclipcrawl.db`.
- Skill routing: `~/Projects/personal/skills/paperclip/SKILL.md` (offline reads → paperclipcrawl).
- Tool doc: `~/Projects/agent-scripts/TOOLS/paperclipcrawl.md` + `TOOLS.md` index entry.

Sync the skill and TOOLS docs through your normal private repository distribution.
These commits may still be local: verify delivery rather than assuming `git pull`
is sufficient. The binary is per-arch; rebuild on the destination with
`bun run install:local`. See the onboarding guide for agent-service PATH and skill checks.

## Development

```sh
bun run dev -- status --json      # run from source
bun run typecheck
bun test                          # stubbed API reader — never hits the network
```

Layout: `src/cli.ts` (arg parsing + commands) · `src/lib/{paths,schema,db,redact,lock,context,
api,store,sync,query,output}.ts` · `test/*.test.ts`.

## Proof of purpose

```sh
# With the API unreachable, reads still serve the last synced board:
paperclipcrawl issue list --api-base http://127.0.0.1:9/ --json | jq length

# After a sync, a sample identifier matches live (scripts/parity-check.sh wraps this):
scripts/parity-check.sh ccs            # newest issue in the mirror
scripts/parity-check.sh ccs CCS-12     # a specific identifier
```
