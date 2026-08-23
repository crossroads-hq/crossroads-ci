#!/usr/bin/env bash
#
# Apply the governance profile to every repository in governance/repositories.txt.
#
# Dry-run is the DEFAULT. Nothing on GitHub changes unless APPLY=1 is set
# explicitly, so the safe invocation is also the lazy one:
#
#   scripts/apply-fleet.sh                # plan only, mutates nothing
#   APPLY=1 scripts/apply-fleet.sh        # apply the plan
#
# The profile JSON files under governance/ are the single source of truth.
# This script never inlines a payload: the previous generation of these
# scripts carried the ruleset both in a JSON file and in an embedded jq
# template, and the two drifted -- the live rulesets gained
# `require_extra_approval_for_unattributed_changes` while the file did not,
# so re-running the old script would have silently downgraded the fleet.
#
# Idempotent by ruleset name: an existing ruleset with the same name is
# updated in place, a missing one is created.

set -euo pipefail

cd "$(dirname "$0")/.."

fleet_file="${1:-governance/repositories.txt}"

command -v gh >/dev/null || { echo "gh CLI is required" >&2; exit 1; }
command -v jq >/dev/null || { echo "jq is required" >&2; exit 1; }
gh auth status >/dev/null 2>&1 || {
  echo "GitHub authentication is unavailable. Run: gh auth login -h github.com" >&2
  exit 1
}

# Render a profile for one repository: fix up the ruleset name and branch ref,
# leave everything else exactly as the file says.
render_branch_profile() {
  profile_file="$1" branch="$2"
  jq --arg name "Crossroads ${branch} protection" \
     --arg ref "refs/heads/${branch}" \
     '.name = $name | .conditions.ref_name.include = [$ref]' \
     "$profile_file"
}

apply_ruleset() {
  repo="$1" payload="$2" target="$3"
  name="$(jq -r '.name' <<<"$payload")"

  if [ "${APPLY:-0}" != "1" ]; then
    echo "  plan: would apply '${name}' (${target})"
    return 0
  fi

  ruleset_id="$(gh api "repos/${repo}/rulesets" \
    | jq -r --arg name "$name" --arg target "$target" \
        '.[] | select(.name == $name and .target == $target) | .id' \
    | head -n 1)"

  if [ -n "$ruleset_id" ]; then
    printf '%s' "$payload" | gh api --method PUT "repos/${repo}/rulesets/${ruleset_id}" --input - --silent
    echo "  applied: updated '${name}' (${ruleset_id})"
  else
    printf '%s' "$payload" | gh api --method POST "repos/${repo}/rulesets" --input - --silent
    echo "  applied: created '${name}'"
  fi
}

status=0
while read -r repo profile branch _; do
  case "$repo" in ''|'#'*) continue ;; esac

  case "$profile" in
    full|full+tags) profile_file="governance/ruleset-full.json" ;;
    minimal)        profile_file="governance/ruleset-minimal.json" ;;
    *)
      echo "${repo}: unknown profile '${profile}'" >&2
      status=1
      continue
      ;;
  esac

  if ! printf '%s' "$repo" | grep -Eq '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$'; then
    echo "malformed repository identifier: '${repo}'" >&2
    status=1
    continue
  fi

  echo "${repo} (${profile}, branch: ${branch})"
  apply_ruleset "$repo" "$(render_branch_profile "$profile_file" "$branch")" branch

  if [ "$profile" = "full+tags" ]; then
    apply_ruleset "$repo" "$(cat governance/tag-ruleset.json)" tag
  fi
done < "$fleet_file"

if [ "${APPLY:-0}" != "1" ]; then
  echo
  echo "Dry run: nothing was changed. Set APPLY=1 to apply."
fi
exit "$status"
