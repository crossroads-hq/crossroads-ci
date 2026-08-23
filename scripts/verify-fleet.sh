#!/usr/bin/env bash
#
# Verify that every repository in governance/repositories.txt carries exactly
# the ruleset its profile prescribes. Exit 1 on any divergence, with a diff.
#
# This is the half that keeps the fleet honest: applying a policy is an event,
# proving the fleet still matches it is the durable thing. Phase 05 runs this
# nightly and opens an issue on failure; it is equally useful by hand after
# clicking around the GitHub settings UI.
#
# Also flags legacy branch protection: a repository carrying both the ruleset
# and an old-style branch protection rule enforces whichever is stricter,
# which makes the effective policy unreadable. The fleet standard is rulesets
# only.

set -euo pipefail

cd "$(dirname "$0")/.."

fleet_file="${1:-governance/repositories.txt}"

command -v gh >/dev/null || { echo "gh CLI is required" >&2; exit 1; }
command -v jq >/dev/null || { echo "jq is required" >&2; exit 1; }

# Reduce a ruleset -- rendered profile or live API object -- to a canonical
# comparable form: the fields we govern, rules sorted by type, parameters
# defaulted to {}, keys sorted.
normalize() {
  jq -S '{
    name,
    target,
    enforcement,
    conditions,
    bypass_actors: (.bypass_actors // []),
    rules: ([.rules[] | {type, parameters: (.parameters // {})}] | sort_by(.type))
  }'
}

render_branch_profile() {
  profile_file="$1" branch="$2"
  jq --arg name "Crossroads ${branch} protection" \
     --arg ref "refs/heads/${branch}" \
     '.name = $name | .conditions.ref_name.include = [$ref]' \
     "$profile_file"
}

status=0

check_ruleset() {
  repo="$1" expected="$2" target="$3"
  name="$(jq -r '.name' <<<"$expected")"

  ruleset_id="$(gh api "repos/${repo}/rulesets" 2>/dev/null \
    | jq -r --arg name "$name" --arg target "$target" \
        '.[] | select(.name == $name and .target == $target) | .id' \
    | head -n 1)"

  if [ -z "$ruleset_id" ]; then
    echo "  DIVERGED: ruleset '${name}' (${target}) is absent"
    status=1
    return 0
  fi

  live="$(gh api "repos/${repo}/rulesets/${ruleset_id}")"
  if ! diff <(printf '%s' "$expected" | normalize) \
            <(printf '%s' "$live" | normalize) >/tmp/ruleset-diff.$$ 2>&1; then
    echo "  DIVERGED: ruleset '${name}' (${target}) differs from the profile:"
    sed 's/^/    /' /tmp/ruleset-diff.$$
    status=1
  else
    echo "  ok: '${name}' (${target})"
  fi
  rm -f /tmp/ruleset-diff.$$
}

while read -r repo profile branch _; do
  case "$repo" in ''|'#'*) continue ;; esac

  case "$profile" in
    full|full+tags) profile_file="governance/ruleset-full.json" ;;
    minimal)        profile_file="governance/ruleset-minimal.json" ;;
    *) echo "${repo}: unknown profile '${profile}'" >&2; status=1; continue ;;
  esac

  echo "${repo} (${profile}, branch: ${branch})"
  check_ruleset "$repo" "$(render_branch_profile "$profile_file" "$branch")" branch

  if [ "$profile" = "full+tags" ]; then
    check_ruleset "$repo" "$(cat governance/tag-ruleset.json)" tag
  fi

  # Legacy branch protection beside a ruleset makes the effective policy the
  # union of the two, which nobody can read at a glance.
  if gh api "repos/${repo}/branches/${branch}/protection" >/dev/null 2>&1; then
    echo "  DIVERGED: legacy branch protection exists on '${branch}' beside the ruleset"
    status=1
  fi
done < "$fleet_file"

if [ "$status" -ne 0 ]; then
  echo
  echo "Fleet diverges from governance/. Reconcile with scripts/apply-fleet.sh," >&2
  echo "or update the profile and review the change as a governance decision." >&2
fi
exit "$status"
