# Onboard a device or agent

Use this guide to install paperclipcrawl on another macOS/Linux device, enable agent routing, and prove offline reads work. Windows is not verified.

## 1. Obtain the source

Clone the public source (the implementation is on the draft-PR branch until merged):

```sh
mkdir -p ~/Projects/personal
git clone --branch lue/paperclip-offline-cache https://github.com/lue-labs/paperclipcrawl.git ~/Projects/personal/paperclipcrawl
cd ~/Projects/personal/paperclipcrawl
```

No binary release is published yet. Do not assume companion skills/docs commits have been pushed.

For offline source transfer only, use this alternative instead of the clone above. On the source Mac, export the committed implementation:

```sh
git -C ~/.herdr/worktrees/paperclipcrawl/lue-paperclip-offline-cache bundle create /tmp/paperclipcrawl.bundle lue/paperclip-offline-cache
```

Transfer the bundle through your approved private file-transfer channel. On the destination:

```sh
mkdir -p ~/Projects/personal
git clone -b lue/paperclip-offline-cache /path/to/paperclipcrawl.bundle ~/Projects/personal/paperclipcrawl
cd ~/Projects/personal/paperclipcrawl
```

This clone's origin is a bundle file, not a hosted repository. For upgrades, transfer a fresh bundle and fetch it, or configure a real remote when one exists. Do not expect `git pull` to download updates from the source Mac automatically.

Done when the destination has `package.json`, `src/`, and this guide.

## 2. Build and install

Install Bun >=1.3 using its official instructions at https://bun.sh, then:

```sh
cd ~/Projects/personal/paperclipcrawl
bun install
bun run typecheck
bun test
bun run install:local
export PATH="$HOME/.local/bin:$PATH"
command -v paperclipcrawl
paperclipcrawl --version
paperclipcrawl init
```

Persist the PATH entry in your shell configuration and the agent service's environment. A service may not read interactive shell startup files. Build on the destination architecture; do not copy the Mac arm64 binary to Linux or x86 machines. The compiled binary needs no Bun runtime.

Done when the agent's actual runtime user can run `paperclipcrawl --version`.

## 3. Authenticate and populate

Install/configure `paperclipai` separately. Use `paperclipai connect --help` and its supported login flow on the destination. Configure the intended company profile there; do not copy tokens into this repository or SQLite. Both tools resolve the same Paperclip context/auth files for the runtime user.

```sh
paperclipcrawl doctor --json
# Replace ccs with a profile configured on this device.
paperclipcrawl sync --profile ccs
paperclipcrawl status --json
paperclipcrawl issue list --profile ccs --json
```

Optional: `paperclipcrawl sync --all` populates all configured profiles. This makes real GET requests and may take longer. A failed sync preserves old data but cannot populate an empty cache. A 503 is a server outage, not a reason to copy credentials or reset the database.

Done when the intended company's sync succeeds and its expected issues appear. Inspect per-company freshness/errors, not only aggregate status.

## 4. Enable agents

Make the existing `paperclip` skill directory (including its references) available through the agent harness's supported skill discovery mechanism:

- Source: `~/Projects/personal/skills/paperclip/`
- CLI reference: `~/Projects/agent-scripts/TOOLS/paperclipcrawl.md`

Sync the committed skills and agent-scripts repositories through your normal private distribution mechanism. Their changes may still be local on the source device; a destination `git pull` alone is not proof of delivery. If your layout differs, ensure the skill's tool-reference path resolves. Start a fresh agent session and ask it to load `paperclip`; verify it actually discovers the skill and can execute the binary.

Suggested task prompt:

> Load the paperclip skill. Check paperclipcrawl status for the requested company. Use paperclipcrawl for cached lists, searches and issue/comment reads, and state the cache freshness. Coordinate one refresh per company rather than syncing independently in every agent. If refresh fails, continue with existing cached reads and disclose the failure. Re-read live with paperclipai before an authorized mutation; never mutate through the cache.

Agents under the same OS user share the local database. Other users, containers, or remote hosts need their own installation/auth/cache unless deliberately provisioned otherwise. The cache contains private issue/comment content even though credentials are redacted; do not publish or casually copy it.

Done when a fresh agent loads the skill, runs a cached read, reports freshness, and does not invoke a mutation.

## 5. Acceptance checks

Run after a successful initial sync (requires jq for counts):

```sh
paperclipcrawl doctor --json
paperclipcrawl issue list --profile ccs --json > /tmp/pc-online-list.json
paperclipcrawl issue list --profile ccs --api-base http://127.0.0.1:9 --json > /tmp/pc-offline-list.json
cmp /tmp/pc-online-list.json /tmp/pc-offline-list.json
paperclipcrawl search payment --api-base http://127.0.0.1:9 --json
# Substitute an identifier from this company's cache:
paperclipcrawl issue get CCS-246 --json
scripts/parity-check.sh ccs CCS-246
```

The list comparison must match without a concurrent sync. Choose a search term present in your data; an empty search is not proof of a populated cache. Parity requires a healthy live API and checks id, identifier, title, status, priority, assigneeAgentId and updatedAt, not every field/comment. `paperclipai` takes `--profile` after its subcommand, e.g. `paperclipai issue get CCS-246 --profile ccs --json`.

Done when doctor passes, offline reads return expected data, and parity reports `PARITY OK`. If the API is down, record parity as blocked rather than claiming success.
