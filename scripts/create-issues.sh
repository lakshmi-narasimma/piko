#!/usr/bin/env bash
# Create GitHub issues for one backlog phase, with its labels and milestone.
# Usage: scripts/create-issues.sh P0 "P0 Setup"
set -euo pipefail
phase=$1 milestone=$2
cd "$(dirname "$0")/.."
repo=$(gh repo view --json nameWithOwner -q .nameWithOwner)

declare -A colors=(
  [human]=d93f0b [core]=0052cc [paypal]=003087 [ai]=8250df
  [ui]=fbca04 [infra]=5319e7 [docs]=0075ca [research]=c5def5
)
for l in "${!colors[@]}"; do
  gh label create "$l" --color "${colors[$l]}" --force >/dev/null
done

if ! gh api "repos/$repo/milestones?state=all" -q '.[].title' | grep -qxF "$milestone"; then
  gh api "repos/$repo/milestones" -f title="$milestone" >/dev/null
fi

existing=$(gh issue list --state all --limit 500 --json title -q '.[].title')
python3 -I scripts/backlog_issues.py docs/BACKLOG.md "$phase" |
python3 -I -c 'import json,sys
for t in json.load(sys.stdin): print(json.dumps(t))' |
while read -r issue; do
  title=$(jq -r .title <<<"$issue")
  if grep -qxF "$title" <<<"$existing"; then echo "skip  $title"; continue; fi
  args=(--title "$title" --body "$(jq -r .body <<<"$issue")" --milestone "$milestone")
  for l in $(jq -r '.labels[]' <<<"$issue"); do args+=(--label "$l"); done
  echo "new   $(gh issue create "${args[@]}")"
done
