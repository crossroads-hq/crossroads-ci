#!/usr/bin/env bash
#
# Report which version of the control plane each fleet repository pins.
#
# scripts/verify-fleet.sh proves the fleet's RULESETS still match governance/.
# This proves the other half: that the shared gate and workflow logic the fleet
# actually runs is the logic in this repository. SHA pinning is the fleet's
# convention and the right one -- a mutable @main would let an unreviewed
# change here reach every repository at once -- but it trades content drift for
# version drift, and nothing measured the second until now.
#
#   scripts/verify-pins.sh            # report; exit 1 only on a BROKEN pin
#   STRICT=1 scripts/verify-pins.sh   # also exit 1 when any pin is behind
#
# "Behind" counts commits touching THAT COMPONENT'S path, not commits on main.
# A gate pinned before thirty governance edits is not behind; a gate pinned
# before one change to actions/gate is. Anything else produces a number that is
# always large, always ignorable, and tells you nothing about whether to bump.
#
# Read-only: GETs against the fleet, and git history that is already local.
#
# Default exit is 0 for a pin that is merely behind. Being behind is a normal,
# often correct state -- consumers bump deliberately, in a reviewed PR -- and a
# check that goes red the moment anything lands here would be red permanently.
# What always fails is a pin that cannot resolve: a ref this repository has no
# such commit for, which means the consumer is pointing at nothing.

set -euo pipefail

cd "$(dirname "$0")/.."

fleet_file="${1:-governance/repositories.txt}"
base="${BASE:-origin/main}"
# Every consumer reference has this form; the local `./actions/gate` this
# repository's own ci.yml uses is deliberately not matched.
control_plane="tsviser/crossroads-ci"

command -v gh >/dev/null || { echo "gh CLI is required" >&2; exit 1; }
gh auth status >/dev/null 2>&1 || {
  echo "GitHub authentication is unavailable. Run: gh auth login -h github.com" >&2
  exit 1
}
git rev-parse --verify --quiet "$base" >/dev/null || {
  echo "cannot resolve '${base}' to compare against; set BASE= to override" >&2
  exit 1
}

# A shallow clone silently makes every pin look unresolvable. Say so instead.
if [ "$(git rev-parse --is-shallow-repository)" = "true" ]; then
  echo "this is a shallow clone; pin history cannot be measured" >&2
  echo "fetch full history first (actions/checkout needs fetch-depth: 0)" >&2
  exit 1
fi

broken=0
behind_total=0
pins_seen=0

report_pin() {
  component="$1" ref="$2" source_file="$3"
  pins_seen=$((pins_seen + 1))

  if ! printf '%s' "$ref" | grep -Eq '^[0-9a-f]{40}$'; then
    # Not a SHA. A tag or branch can be moved under the consumer without any
    # review on either side, which is the thing pinning exists to prevent.
    printf '    %-42s %-10s UNPINNED (mutable ref)  [%s]\n' "$component" "$ref" "$source_file"
    behind_total=$((behind_total + 1))
    return 0
  fi

  if ! git cat-file -e "${ref}^{commit}" 2>/dev/null; then
    # Try once: a commit that is reachable but not yet fetched locally.
    git fetch --quiet origin "$ref" 2>/dev/null || true
  fi
  if ! git cat-file -e "${ref}^{commit}" 2>/dev/null; then
    printf '    %-42s %-10.8s BROKEN: no such commit in this repository  [%s]\n' \
      "$component" "$ref" "$source_file"
    broken=1
    return 0
  fi

  n="$(git rev-list --count "${ref}..${base}" -- "$component")"
  when="$(git log -1 --format=%cs "$ref")"

  if [ "$n" -eq 0 ]; then
    printf '    %-42s %-10.8s current  (%s)\n' "$component" "$ref" "$when"
    return 0
  fi

  printf '    %-42s %-10.8s %s change(s) behind  (%s)\n' "$component" "$ref" "$n" "$when"
  # The actionable half: what bumping would actually bring in.
  git log --format='          %h %s' "${ref}..${base}" -- "$component" | head -n 5
  if [ "$n" -gt 5 ]; then
    printf '          ... and %s more\n' "$((n - 5))"
  fi
  behind_total=$((behind_total + 1))
}

while read -r repo profile branch _; do
  case "$repo" in ''|'#'*) continue ;; esac
  # profile is unused here; every repository is scanned regardless of tier.
  : "$profile"

  # Key on gh's exit status, not on empty output: `gh api` prints the 404 body
  # to STDOUT, so a repository with no .github/workflows hands back a JSON
  # error object that reads as a perfectly non-empty file list.
  if ! workflows="$(gh api "repos/${repo}/contents/.github/workflows?ref=${branch}" \
      --jq '.[] | select(.type == "file") | .name' 2>/dev/null)"; then
    workflows=""
  fi

  if [ -z "$workflows" ]; then
    # Tier D has no CI by definition; this is a fact, not a divergence.
    printf '%s\n    no workflows on %s\n' "$repo" "$branch"
    continue
  fi

  echo "$repo"
  found=0
  while IFS= read -r wf; do
    [ -n "$wf" ] || continue
    if ! encoded="$(gh api "repos/${repo}/contents/.github/workflows/${wf}?ref=${branch}" \
        --jq '.content' 2>/dev/null)"; then
      printf '    could not read %s\n' "$wf"
      continue
    fi
    body="$(printf '%s' "$encoded" | base64 -d 2>/dev/null || true)"
    [ -n "$body" ] || continue

    # `uses:` only. A bare mention of the control plane in a comment is not a
    # dependency, and counting one as a pin sends someone chasing prose.
    refs="$(printf '%s\n' "$body" \
      | grep -E '^[[:space:]]*(-[[:space:]]+)?uses:' \
      | grep -ohE "${control_plane}/[A-Za-z0-9._/-]+@[A-Za-z0-9._-]+" \
      | sort -u || true)"

    while IFS= read -r pin; do
      [ -n "$pin" ] || continue
      found=1
      component="${pin#"${control_plane}/"}"
      report_pin "${component%@*}" "${pin##*@}" "$wf"
    done <<<"$refs"
  done <<<"$workflows"

  if [ "$found" -ne 1 ]; then
    if [ "$repo" = "$control_plane" ]; then
      echo "    the control plane itself; ci.yml calls ./actions/gate locally"
    else
      echo "    no control-plane pins"
    fi
  fi
done < "$fleet_file"

echo
echo "${pins_seen} pin(s); ${behind_total} behind or unpinned; base ${base} at $(git rev-parse --short "$base")"

if [ "$broken" -ne 0 ]; then
  echo
  echo "A pin does not resolve to a commit in this repository. The consumer is" >&2
  echo "referencing something that no longer exists; fix it there." >&2
  exit 1
fi

if [ "$behind_total" -ne 0 ] && [ "${STRICT:-0}" = "1" ]; then
  exit 1
fi
exit 0
