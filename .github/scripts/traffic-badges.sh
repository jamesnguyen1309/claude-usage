#!/usr/bin/env bash
# Reads the repository's clone traffic (GitHub keeps only the last 14 days), adds each day to the
# history kept beside the badges, and writes two shields.io endpoint files: pulls over all time,
# and unique pulls over the last 14 days (GitHub never says who cloned, so uniques can't be summed).
#
#   .github/scripts/traffic-badges.sh owner/repo     # needs GH_TOKEN with read access to traffic
set -euo pipefail

repo="${1:?usage: traffic-badges.sh owner/repo}"
dir="$(cd "$(dirname "$0")/.." && pwd)/badges"
history="$dir/clones-history.json"
mkdir -p "$dir"
[ -f "$history" ] || echo '{}' >"$history"

traffic="$(gh api "repos/$repo/traffic/clones")"

# Each day GitHub reports replaces what was kept for it: today's count grows until the day ends.
jq --argjson t "$traffic" \
  '(. + ($t.clones | map({(.timestamp[:10]): {count, uniques}}) | add // {})) | to_entries | sort_by(.key) | from_entries' \
  "$history" >"$history.tmp"
mv "$history.tmp" "$history"

total="$(jq '[.[].count] | add // 0' "$history")"
uniques="$(jq '.uniques' <<<"$traffic")"

badge() {
  jq -n --arg label "$1" --arg message "$2" --arg color "$3" \
    '{schemaVersion: 1, label: $label, message: $message, color: $color}' >"$dir/$4"
}
badge 'pulls' "$total" '1D9E75' pulls.json
badge 'unique pulls · 14 days' "$uniques" '378ADD' unique-pulls.json

echo "pulls $total · unique pulls (14 days) $uniques"
