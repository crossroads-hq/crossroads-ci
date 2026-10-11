#!/usr/bin/env bash
#
# Delete the remote branches that are finished with, on every repository in
# governance/repositories.txt.
#
# Dry-run is the DEFAULT. Nothing on GitHub changes unless APPLY=1 is set
# explicitly, so the safe invocation is also the lazy one:
#
#   scripts/clean-branches.sh                # list what would go, delete nothing
#   APPLY=1 scripts/clean-branches.sh        # delete it
#
# A branch is deletable only when ALL of these hold:
#   - it is not the repository's default branch, nor the branch the roster
#     names for it (column 3), nor a protected branch;
#   - it matches none of KEEP_PATTERNS (default: gh-readonly-queue/*, the
#     merge queue's own temporary branches);
#   - no open pull request has it as its head, from any repository;
#   - a CLOSED pull request from this repository has this branch's current tip
#     as its head commit. A merged or closed pull request whose head is still the
#     tip means nothing has been pushed since: the work is either on the default
#     branch or recoverable from refs/pull/<n>/head.
# A branch with no pull request is never deleted, however old, and neither is
# one that has had commits pushed since its pull request closed. "Merged into
# the default branch" is deliberately not a test of its own: a branch created
# today from the tip of the default branch is "merged" too.
#
# Every deletion prints the branch's tip, so it can be put back with
#   git push origin <sha>:refs/heads/<name>
#
# Unknown state is not absence: a list that cannot be read in full, or a branch
# that cannot be classified, is an error (exit 1) and that branch is kept. More
# than MAX_DELETE deletable branches in one repository is treated as surprising
# and deletes none of them there.
#
# Local branches are not touched here; GitHub cannot see them. The runner hosts
# prune theirs in runner-host/fleet-runner-clean.sh.
#
# GH_TOKEN needs Contents: write and Pull requests: read on every repository
# (the branch-cleaner App, see README "Weekly cleanup"). GH is overridable so
# the logic can be tested against a stub (scripts/clean-branches.test.js).
set -euo pipefail

cd "$(dirname "$0")/.."

GH="${GH:-gh}"
fleet_file="${1:-governance/repositories.txt}"
MAX_DELETE="${MAX_DELETE:-50}"
KEEP_PATTERNS="${KEEP_PATTERNS:-gh-readonly-queue/*}"

command -v jq >/dev/null || { echo "jq is required" >&2; exit 1; }
command -v "$GH" >/dev/null || { echo "gh CLI is required" >&2; exit 1; }
case "$MAX_DELETE" in ''|*[!0-9]*) echo "MAX_DELETE must be a whole number" >&2; exit 2;; esac
if [ -z "${GH_TOKEN:-}" ]; then
  "$GH" auth status >/dev/null 2>&1 || {
    echo "GitHub authentication is unavailable. Set GH_TOKEN or run: gh auth login -h github.com" >&2
    exit 1
  }
fi

status=0
say() {
  printf '%s\n' "$*"
  if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then printf '%s\n' "$*" >> "$GITHUB_STEP_SUMMARY"; fi
}
fail() {
  echo "::error::$*" >&2
  say "- ERROR: $*"
  status=1
}

# stdin is the fleet file inside the main loop; gh must not read it.
gh_api() { "$GH" api "$@" </dev/null; }

# Percent-encode a ref name for a URL, keeping the slashes.
uri() { jq -rn --arg v "$1" '$v | @uri | gsub("%2F"; "/")'; }

# One JSON array of every item of a paginated list endpoint. A response that
# is not a list of pages is an error, never an empty list.
list() {
  local out
  out="$(gh_api --paginate --slurp "$1")" || return 1
  jq -ce 'if all(.[]; type == "array") then [.[][]] else error("not a list") end' <<<"$out"
}

kept_by_pattern() {
  local pattern
  # shellcheck disable=SC2086 # KEEP_PATTERNS is a list of globs, split on purpose
  for pattern in $KEEP_PATTERNS; do
    # shellcheck disable=SC2254 # the glob is meant to expand
    case "$1" in $pattern) return 0 ;; esac
  done
  return 1
}

# Prints why a branch can go, or nothing when it must stay. Fails when the
# answer cannot be known.
deletable_reason() {
  local repo="$1" owner="$2" name="$3" sha="$4" prs
  prs="$(list "repos/$repo/pulls?state=all&head=$(jq -rn --arg v "$owner:$name" '$v | @uri')&per_page=100")" || return 1
  jq -er --arg sha "$sha" --arg repo "$repo" '
    map(select(.state == "closed" and .head.sha == $sha and ((.head.repo.full_name // "") == $repo)))
    | first // empty
    | "pull request #\(.number) \(if .merged_at then "merged" else "closed" end), head unchanged"
  ' <<<"$prs" || true
}

total_deleted=0 total_kept=0
clean_repo() {
  local repo="$1" roster_branch="$2" owner default branches open_heads
  local name sha reason kept=0
  local -a doomed_names=() doomed_shas=() doomed_reasons=()
  owner="${repo%%/*}"

  default="$(gh_api "repos/$repo" | jq -er '.default_branch')" \
    || { fail "$repo: cannot read the default branch"; return 0; }
  branches="$(list "repos/$repo/branches?per_page=100")" \
    || { fail "$repo: cannot read the branch list in full"; return 0; }
  open_heads="$(list "repos/$repo/pulls?state=open&per_page=100")" \
    || { fail "$repo: cannot read the open pull requests in full"; return 0; }
  open_heads="$(jq -c '[.[].head.ref]' <<<"$open_heads")" \
    || { fail "$repo: unreadable open pull request list"; return 0; }

  while IFS=$'\t' read -r name sha; do
    [ -n "$name" ] || continue
    if [ "$name" = "$default" ] || [ "$name" = "$roster_branch" ] || kept_by_pattern "$name"; then
      kept=$((kept + 1)); continue
    fi
    if jq -e --arg n "$name" 'index($n) != null' <<<"$open_heads" >/dev/null; then
      kept=$((kept + 1)); continue
    fi
    if ! reason="$(deletable_reason "$repo" "$owner" "$name" "$sha")"; then
      fail "$repo: cannot classify branch '$name'; kept"
      kept=$((kept + 1)); continue
    fi
    if [ -z "$reason" ]; then kept=$((kept + 1)); continue; fi
    doomed_names+=("$name"); doomed_shas+=("$sha"); doomed_reasons+=("$reason")
  done < <(jq -r '.[] | select(.protected | not) | [.name, .commit.sha] | @tsv' <<<"$branches")

  if [ "${#doomed_names[@]}" -gt "$MAX_DELETE" ]; then
    fail "$repo: ${#doomed_names[@]} deletable branches is more than MAX_DELETE=$MAX_DELETE; deleting none here"
    total_kept=$((total_kept + kept + ${#doomed_names[@]}))
    return 0
  fi

  local i
  for i in "${!doomed_names[@]}"; do
    name="${doomed_names[$i]}"
    if [ "${APPLY:-0}" != "1" ]; then
      say "- plan: would delete $repo:$name (${doomed_shas[$i]}), ${doomed_reasons[$i]}"
      continue
    fi
    if gh_api -X DELETE "repos/$repo/git/refs/heads/$(uri "$name")" --silent; then
      say "- deleted $repo:$name (${doomed_shas[$i]}), ${doomed_reasons[$i]}"
      total_deleted=$((total_deleted + 1))
    else
      fail "$repo: could not delete '$name'"
      kept=$((kept + 1))
    fi
  done
  total_kept=$((total_kept + kept))
  if [ "${APPLY:-0}" != "1" ]; then total_deleted=$((total_deleted + ${#doomed_names[@]})); fi
}

say "### Branch cleanup"
say ""
while read -r repo profile branch _; do
  case "$repo" in ''|'#'*) continue ;; esac

  if ! printf '%s' "$repo" | grep -Eq '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$'; then
    fail "malformed repository identifier: '${repo}'"
    continue
  fi
  if [ -z "${branch:-}" ]; then
    fail "${repo}: no branch in the roster line"
    continue
  fi

  say "${repo} (${profile}, branch: ${branch})"
  clean_repo "$repo" "$branch"
done < "$fleet_file"

say ""
if [ "${APPLY:-0}" = "1" ]; then
  say "Deleted ${total_deleted}, kept ${total_kept}."
else
  say "Dry run: would delete ${total_deleted}, kept ${total_kept}. Nothing was changed. Set APPLY=1 to delete."
fi
exit "$status"
