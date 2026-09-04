#!/usr/bin/env bash
#
# Verify the ORG rulesets still match the checked-in profiles.
#
# This is the question the retired verify-fleet.sh was built for, asked at the
# level it now lives at. That script compared each REPOSITORY against a
# profile; once governance moved to org rulesets targeting a custom property
# there was no per-repository ruleset to compare, so it answered DIVERGED for
# the whole fleet and was removed. Nobody then asked whether the three org
# rulesets -- the things that actually protect every repository -- still say
# what governance/ says they say.
#
# They did not, and nothing noticed:
#
#   - `Fleet — minimal protection` sat at `enforcement: evaluate` while
#     ruleset-minimal.json said `active`. Evaluate mode reports and blocks
#     nothing, so every `minimal` repository was unprotected while every
#     script in this repository reported clean. Found by hand 2026-09-03.
#
# An org ruleset is a single object protecting the whole fleet, which is what
# makes this cheap to check and expensive to get wrong: one wrong field is not
# one repository's problem, it is everyone's, and it is invisible from every
# per-repository angle.
#
# WHAT IS COMPARED, and what deliberately is not:
#
#   Compared -- the substance. `target`, `enforcement`, `bypass_actors`, and
#   every rule with its parameters. This is what decides whether a push is
#   refused.
#
#   NOT compared -- `name` and `conditions`. The checked-in profiles were
#   written for the repo-level generation: they carry repo-level names
#   ("Crossroads main protection") and explicit refs (`refs/heads/main`),
#   while the org rulesets carry fleet names and target `~DEFAULT_BRANCH` by
#   custom property. Those differences are the migration, not drift, and
#   diffing them would report the same three findings forever -- a check that
#   cries wolf gets muted, and a muted check is worse than none.
#
#   Conditions are still checked, just not by diff: the table below declares
#   the property and refs each ruleset must target, because a ruleset with
#   perfect rules pointed at nothing protects nothing. That expectation cannot
#   live in the profile JSON -- the JSON predates property targeting -- so it
#   lives here, in the repository, reviewed like anything else.
#
# Exit 1 on drift, and on anything that could not be checked. Unlike
# verify-pins.sh there is no tolerated "not current" state: an org ruleset
# either matches what governance/ prescribes or the fleet is not protected the
# way this repository claims.
#
# Read-only: GETs only.

set -euo pipefail

cd "$(dirname "$0")/.."

ORG="${FLEET_ORG:-crossroads-hq}"

command -v gh >/dev/null || { echo "gh CLI is required" >&2; exit 1; }
command -v jq >/dev/null || { echo "jq is required" >&2; exit 1; }
gh auth status >/dev/null 2>&1 || {
  echo "GitHub authentication is unavailable. Run: gh auth login -h github.com" >&2
  exit 1
}

status=0
seen_names=""

# profile file | org ruleset name | property | comma-separated values | ref include
#
# The property column is not always `fleet-profile`: release tags target
# `publishes-npm`, because publishing from a tag push is a different fact
# about a repository than which protection tier it sits in.
profiles() {
  cat <<'PROFILES'
governance/ruleset-full.json|Fleet — full protection|fleet-profile|full,full-tags|~DEFAULT_BRANCH
governance/ruleset-minimal.json|Fleet — minimal protection|fleet-profile|minimal|~DEFAULT_BRANCH
governance/tag-ruleset.json|Fleet — release tags|publishes-npm|true|refs/tags/v*
PROFILES
}

# Reduce a ruleset to what actually decides whether a push is refused.
#
# `dismissal_restriction` is dropped ONLY when disabled. GitHub echoes
# `{allowed_actors: [], enabled: false}` on some reads and omits it on others
# for the same effective policy, so comparing it verbatim reports drift that
# does not exist -- while an ENABLED restriction is a real difference and
# survives.
canon() {
  # Every array here is a SET: allowed_merge_methods, required_status_checks
  # contexts, bypass_actors, ref_name includes. None carries meaning in its
  # order, and GitHub does not promise to return them in the order the profile
  # JSON lists them -- so an unsorted compare reports drift that is not there,
  # on a check whose whole value is that it only speaks when something is
  # wrong. `walk` sorts every array at every depth; `tostring` gives arrays of
  # objects a stable key without naming their fields, so a rule type this
  # script has never seen still normalises.
  jq -S 'def norm: walk(if type == "array" then sort_by(tostring) else . end);
  {
    target,
    enforcement,
    bypass_actors: ((.bypass_actors // []) | norm),
    rules: (.rules // [] | sort_by(.type) | map({
      type,
      parameters: ((.parameters // {})
        | if has("dismissal_restriction") and .dismissal_restriction.enabled == false
          then del(.dismissal_restriction) else . end
        | norm)
    }))
  }'
}

# Paginated. `gh api` fetches ONE page unless told otherwise, so an org past
# the default page size would hide rulesets past it -- and a ruleset this
# script cannot see reads as "no org ruleset named X", which is a MUST FIX
# pointing at the wrong thing. --slurp yields an array of pages, flattened
# with `.[][]`, the same house pattern audit-fleet-drift.sh uses.
org_json="$(gh api --paginate --slurp "orgs/$ORG/rulesets" 2>/dev/null | jq '[.[][]]')" || {
  echo "Could not list rulesets for '$ORG'. The token needs org read access." >&2
  exit 1
}

while IFS='|' read -r profile_file name prop values ref; do
  [ -n "$profile_file" ] || continue
  echo "${name}  <-  ${profile_file}"
  seen_names="${seen_names}${name}
"

  if [ ! -r "$profile_file" ]; then
    echo "  BROKEN: cannot read $profile_file"
    status=1
    continue
  fi

  id="$(jq -r --arg n "$name" '.[] | select(.name == $n) | .id' <<<"$org_json")"
  if [ -z "$id" ]; then
    echo "  DIVERGED: no org ruleset named '${name}'. Nothing applies this profile."
    status=1
    continue
  fi

  live="$(gh api "orgs/$ORG/rulesets/$id" 2>/dev/null)" || {
    echo "  BROKEN: ruleset $id could not be read; this profile was NOT checked"
    status=1
    continue
  }

  # Substance. mktemp, not a `$$`-suffixed literal: /tmp is shared and
  # world-writable, and a predictable name is one a concurrent process can
  # pre-create as a symlink for this redirect to follow.
  diff_out="$(mktemp)"
  if diff -u <(canon < "$profile_file") <(canon <<<"$live") > "$diff_out" 2>&1; then
    echo "  ok: rules, parameters, enforcement and bypass match"
  else
    echo "  DIVERGED: live ruleset ${id} differs from the profile:"
    sed -e 's/^/    /' -e '1,2d' "$diff_out"
    status=1
  fi
  rm -f "$diff_out"

  # Targeting. Perfect rules pointed at nothing protect nothing.
  want_values="$(printf '%s' "$values" | tr ',' '\n' | sort | paste -sd, -)"
  got_values="$(jq -r --arg p "$prop" \
    '[.conditions.repository_property.include[]? | select(.name == $p) | .property_values[]?] | sort | join(",")' \
    <<<"$live")"
  if [ "$want_values" != "$got_values" ]; then
    echo "  DIVERGED: targets ${prop}=[${got_values:-none}], expected [${want_values}]"
    status=1
  fi

  got_ref="$(jq -r '[.conditions.ref_name.include[]?] | join(",")' <<<"$live")"
  if [ "$got_ref" != "$ref" ]; then
    echo "  DIVERGED: targets refs [${got_ref:-none}], expected [${ref}]"
    status=1
  fi
done <<EOF
$(profiles)
EOF

# An org ruleset nobody reviewed protects the fleet just as hard as one that
# was. Report anything live that this repository does not describe.
while IFS= read -r live_name; do
  [ -n "$live_name" ] || continue
  if ! grep -qxF "$live_name" <<<"$seen_names"; then
    echo "${live_name}"
    echo "  DIVERGED: live org ruleset that no profile in governance/ describes"
    status=1
  fi
done <<<"$(jq -r '.[].name' <<<"$org_json")"

echo
if [ "$status" -ne 0 ]; then
  echo "Org rulesets diverge from governance/. Either the live ruleset is wrong," >&2
  echo "or the profile is -- and which one is a governance decision, not a" >&2
  echo "reconciliation to run blind. Do NOT reach for apply-fleet.sh: it writes" >&2
  echo "REPO-level rulesets and would shadow the org rules rather than fix them." >&2
  exit 1
fi
echo "Org rulesets match governance/."
exit 0
