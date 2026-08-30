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
#   scripts/verify-pins.sh            # report; exit 1 on anything UNCHECKABLE
#   STRICT=1 scripts/verify-pins.sh   # also exit 1 on anything NOT CURRENT
#
# Precisely, because the two categories are easy to conflate:
#
#   Always exit 1 -- the run could not establish the answer. A pin naming a
#   commit or component this repository does not have; a repository whose
#   workflow listing could not be read; a workflow file that could not be
#   fetched or decoded; and, for a profile that requires a gate, a repository
#   with no workflows at all or an empty workflows directory.
#
#   Exit 1 only under STRICT -- the answer is known and is "not current".
#   A pin behind on its component, a mutable ref, or a ref that is not an
#   ancestor of the base. These are normal states a fleet passes through, so
#   they report and exit 0 by default.
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

  if ! printf '%s' "$ref" | grep -Eq '^[0-9a-fA-F]{40}$'; then
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

  # A path that exists at neither end is a pin to something this repository
  # no longer ships. rev-list counts zero commits touching it, so the pin would
  # read as `current` -- the most misleading answer available.
  if ! git cat-file -e "${ref}:${component}" 2>/dev/null \
     && ! git cat-file -e "${base}:${component}" 2>/dev/null; then
    printf '    %-42s %-10.8s BROKEN: no such component at this ref or on %s  [%s]\n' \
      "$component" "$ref" "$base" "$source_file"
    broken=1
    return 0
  fi

  when="$(git log -1 --format=%cs "$ref")"

  # `ref..base` counts what BASE has that REF lacks. For a pin off a branch
  # that never merged, that can be zero while the pin carries component
  # changes of its own -- reported as `current` when the consumer is actually
  # running control-plane code this repository never merged.
  if ! git merge-base --is-ancestor "$ref" "$base" 2>/dev/null; then
    printf '    %-42s %-10.8s DIVERGED: not an ancestor of %s  (%s)  [%s]\n' \
      "$component" "$ref" "$base" "$when" "$source_file"
    behind_total=$((behind_total + 1))
    return 0
  fi

  n="$(git rev-list --count "${ref}..${base}" -- "$component")"

  if [ "$n" -eq 0 ]; then
    printf '    %-42s %-10.8s current  (%s)\n' "$component" "$ref" "$when"
    return 0
  fi

  printf '    %-42s %-10.8s %s change(s) behind  (%s)\n' "$component" "$ref" "$n" "$when"
  # The actionable half: what bumping would actually bring in.
  # `-n 5`, not `| head -n 5`: head closes the pipe, git takes SIGPIPE, and
  # pipefail turns that into rc 141 -- aborting the whole run precisely when a
  # component has enough changes to be worth reading. Verified before fixing.
  git log -n 5 --format='          %h %s' "${ref}..${base}" -- "$component"
  if [ "$n" -gt 5 ]; then
    printf '          ... and %s more\n' "$((n - 5))"
  fi
  behind_total=$((behind_total + 1))
}

while read -r repo profile branch _; do
  case "$repo" in ''|'#'*) continue ;; esac

  # Key on gh's exit status, not on empty output: `gh api` prints the 404 body
  # to STDOUT, so a repository with no .github/workflows hands back a JSON
  # error object that reads as a perfectly non-empty file list.
  #
  # And distinguish WHICH failure. Collapsing every error to "no workflows"
  # meant revoked access, a rename, a rate limit or any 5xx read as "nothing
  # to check here" and exited 0 -- hiding every pin in that repository,
  # including a broken one. Only a 404 says the directory is absent; anything
  # else says this script did not get to look.
  err="$(mktemp)"
  if workflows="$(gh api "repos/${repo}/contents/.github/workflows?ref=${branch}" \
      --jq '.[] | select(.type == "file") | .name' 2>"$err")"; then
    api_rc=0
  else
    api_rc=1
  fi

  if [ "$api_rc" -ne 0 ]; then
    if grep -q 'HTTP 404' "$err"; then
      # Absent directory. Expected for a `minimal` repository -- that profile
      # exists precisely because the repository has no CI. For a `full` one it
      # is a contradiction: full requires a PR Validation gate, and a gate
      # lives in a workflow.
      case "$profile" in
        minimal)
          printf '%s\n    no workflows on %s (minimal: expected)\n' "$repo" "$branch"
          ;;
        *)
          printf '%s\n    BROKEN: profile %s requires a PR Validation gate, but %s has no .github/workflows\n' \
            "$repo" "$profile" "$branch"
          broken=1
          ;;
      esac
    else
      printf '%s\n    UNREACHABLE: could not list .github/workflows on %s\n' "$repo" "$branch"
      sed 's/^/        /' "$err"
      broken=1
    fi
    rm -f "$err"
    continue
  fi
  rm -f "$err"

  if [ -z "$workflows" ]; then
    # Same judgement as the 404 above, for the same reason: `full` requires a
    # PR Validation gate, and a gate lives in a workflow file. A directory
    # that exists but holds none is exactly as gate-less as a missing one, and
    # reporting it as an unremarkable fact hid that.
    case "$profile" in
      minimal)
        printf '%s\n    no workflow files on %s (minimal: expected)\n' "$repo" "$branch"
        ;;
      *)
        printf '%s\n    BROKEN: profile %s requires a PR Validation gate, but %s has an empty .github/workflows\n' \
          "$repo" "$profile" "$branch"
        broken=1
        ;;
    esac
    continue
  fi

  echo "$repo"
  found=0
  while IFS= read -r wf; do
    [ -n "$wf" ] || continue
    # Both failure paths below set `broken`. A workflow whose pins were never
    # examined must not be reported as clean -- that is the same
    # green-having-checked-nothing this script exists to detect, and the
    # contents API reaches it easily: `.content` comes back EMPTY for a file
    # over 1 MB, which decodes to nothing and looks exactly like "no pins".
    if ! encoded="$(gh api "repos/${repo}/contents/.github/workflows/${wf}?ref=${branch}" \
        --jq '.content' 2>/dev/null)"; then
      printf '    UNREADABLE: %s could not be fetched\n' "$wf"
      broken=1
      continue
    fi
    if ! body="$(printf '%s' "$encoded" | base64 -d 2>/dev/null)" || [ -z "$body" ]; then
      printf '    UNREADABLE: %s did not decode (over the 1 MB contents limit?)\n' "$wf"
      broken=1
      continue
    fi

    # `uses:` only. A bare mention of the control plane in a comment is not a
    # dependency, and counting one as a pin sends someone chasing prose.
    refs="$(printf '%s\n' "$body" \
      | grep -E '^[[:space:]]*(-[[:space:]]+)?uses:' \
      | grep -ohE "${control_plane}/[A-Za-z0-9._/-]+@[A-Za-z0-9._/-]+" \
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
echo "${pins_seen} pin(s); ${behind_total} not current (behind, unpinned or diverged); base ${base} at $(git rev-parse --short "$base")"

if [ "$broken" -ne 0 ]; then
  echo
  echo "Something above could not be checked, or resolves to nothing. Either a" >&2
  echo "consumer references a commit or component this repository does not have," >&2
  echo "or this run could not read a repository it was asked about. Both mean the" >&2
  echo "report above is incomplete -- do not read it as a clean fleet." >&2
  exit 1
fi

if [ "$behind_total" -ne 0 ] && [ "${STRICT:-0}" = "1" ]; then
  exit 1
fi
exit 0
