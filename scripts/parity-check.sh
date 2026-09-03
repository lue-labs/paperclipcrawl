#!/usr/bin/env bash
# Prove mirror ⇄ live parity for one issue: sync the profile, then diff the stable
# fields of `paperclipcrawl issue get --raw` against `paperclipai issue get --json`.
#
#   scripts/parity-check.sh <profile> [identifier]
#
# Without an identifier, the most recently updated issue in the mirror is used.
# Exit 0 = match, 1 = mismatch, 2 = precondition (API down, nothing synced).
set -euo pipefail
profile=${1:?profile}
ident=${2:-}
fields='{id,identifier,title,status,priority,assigneeAgentId,updatedAt}'

# Sync is best-effort: a partial sync (exit 2, e.g. agents timed out) still refreshes issues.
# Only a hard failure with nothing to compare is a precondition error.
paperclipcrawl sync --profile "$profile" --comments none --quiet || rc=$?
if [[ ${rc:-0} -ne 0 && ${rc:-0} -ne 2 ]]; then
  echo "sync failed for profile $profile (exit $rc; API down?)" >&2
  exit 2
fi
if [[ -z "$ident" ]]; then
  ident=$(paperclipcrawl issue list --profile "$profile" --limit 1 --json | jq -r '.[0].identifier // empty')
  [[ -n "$ident" ]] || { echo "mirror has no issues for $profile" >&2; exit 2; }
fi

mirror=$(paperclipcrawl issue get "$ident" --profile "$profile" --raw | jq -S "$fields")
# paperclipai takes --profile per subcommand, not globally.
live=$(paperclipai issue get "$ident" --profile "$profile" --json | jq -S "$fields")

if diff <(echo "$mirror") <(echo "$live") >/dev/null; then
  echo "PARITY OK  $ident  (profile=$profile)"
  echo "$live" | jq -c .
else
  echo "PARITY MISMATCH  $ident" >&2
  diff <(echo "$mirror") <(echo "$live") || true
  exit 1
fi
