#!/usr/bin/env bash
# Scan the tracked release tree for credentials and private deployment markers.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "release-scan: not inside a git worktree" >&2
  exit 2
fi

# The lockfile is the sole exclusion: it is generated dependency metadata and
# can contain arbitrary package descriptions or integrity strings. Everything
# else returned by git ls-files is part of the release scan, including tests,
# docs, examples, scripts, dotfiles, and this scanner itself.
pathspec=(
  .
  ':(exclude)package-lock.json'
)

# Keep private marker spellings split in this policy file so the scanner can scan
# itself without a blanket self-exclusion. Deployment patterns are deliberately
# exact: compatibility names (including NBMG, OpenClaw, and Hermes), ordinary
# plan/account prose, and the public Nextbasedev repository are release-safe.
# OSS-SCOPE.md is legacy packaging policy prose and will be replaced by the
# packaging branch; its generic marker names are not findings by themselves.
patterns=(
  'gh[oprsu]_[A-Za-z0-9_]{20,}'
  'github_pat_[A-Za-z0-9_]{20,}'
  'sk-(proj-|ant-|svcacct-)?[A-Za-z0-9_-]{20,}'
  'xai-[A-Za-z0-9_-]{20,}'
  'AKIA[0-9A-Z]{16}'
  'AIza[0-9A-Za-z_-]{30,}'
  'xox[baprs]-[0-9A-Za-z-]{20,}'
  'npm_[A-Za-z0-9]{20,}'
  '-----BEGIN (RSA |OPENSSH |EC |PGP )?PRIVATE KEY( BLOCK)?-----'
  '(postgres|postgresql|mysql|mongodb(\+srv)?):[^[:space:]/]*//[^[:space:]/:]+:[^[:space:]@]+@'
  'am''pere-5b695'
  'infinity''corp\.tech'
  '65\.21\.109\.171'
  'daxitm(2112|432)@'
  'da''xitdon/'
  'open''claw-inter''nal'
  'next''base-model-gate''way'
  'register''Aside'
  'register''OcFleet'
  '/api/inter''nal/oc/as''ide/'
  '/api/inter''nal/oc/se''crets'
  'aside_''gateways'
  'x-oc-''fleet-key'
)

labels=(
  'GitHub token'
  'GitHub fine-grained token'
  'provider API key'
  'xAI API key'
  'AWS access key id'
  'Google API key'
  'Slack token'
  'npm token'
  'private key block'
  'credential-bearing database URL'
  'private deployment id'
  'company domain'
  'private deployment host'
  'personal email'
  'private repository owner'
  'private client deployment id'
  'private gateway deployment id'
  'control-plane registration symbol'
  'fleet registration symbol'
  'aside control-plane route'
  'fleet secrets route'
  'aside control-plane table'
  'fleet credential header'
)

# Personal names are only findings when they appear as attribution metadata.
# The case-sensitive spelling avoids flagging ordinary prose and contractions.
case_sensitive_patterns=(
  "(Author|Maintainer|Copyright|Created by|created by|author|maintainer|copyright)[^[:cntrl:]]*(D""on|Da""xit)([^[:alnum:]_]|$)"
)
case_sensitive_labels=(
  'personal-name attribution'
)

if [[ "${#patterns[@]}" -ne "${#labels[@]}" \
   || "${#case_sensitive_patterns[@]}" -ne "${#case_sensitive_labels[@]}" ]]; then
  echo "release-scan: invalid scanner configuration" >&2
  exit 2
fi

hits_file="$(mktemp)"
trap 'rm -f "$hits_file"' EXIT
fail=0

report_hits() {
  local label="$1"
  echo "release-scan HIT: $label" >&2
  while IFS= read -r file; do
    printf '  %s\n' "$file" >&2
  done <"$hits_file"
  fail=1
}

for i in "${!patterns[@]}"; do
  : >"$hits_file"
  if git grep -I -l -E -i -e "${patterns[$i]}" -- "${pathspec[@]}" >"$hits_file"; then
    report_hits "${labels[$i]}"
  fi
done

for i in "${!case_sensitive_patterns[@]}"; do
  : >"$hits_file"
  if git grep -I -l -E -e "${case_sensitive_patterns[$i]}" -- "${pathspec[@]}" >"$hits_file"; then
    report_hits "${case_sensitive_labels[$i]}"
  fi
done

tracked_count="$(git ls-files | wc -l | tr -d '[:space:]')"
excluded_count=0
if git ls-files --error-unmatch package-lock.json >/dev/null 2>&1; then
  excluded_count=1
fi
scanned_count=$((tracked_count - excluded_count))

if [[ "$fail" -ne 0 ]]; then
  echo "release-scan: FAILED (${scanned_count} tracked files checked; package-lock.json excluded)" >&2
  exit 1
fi

echo "release-scan: clean (${scanned_count} tracked files checked; package-lock.json excluded)"
