#!/usr/bin/env bash
#
# Report, and with APPLY=1 remove, self-hosted runner registrations that are
# offline, for every organization and repository in governance/repositories.txt.
#
# Dry-run is the DEFAULT. Nothing on GitHub changes unless APPLY=1 is set
# explicitly:
#
#   scripts/clean-runners.sh                # list offline registrations
#   APPLY=1 scripts/clean-runners.sh        # remove them
#
# READ THIS BEFORE SETTING APPLY=1. GitHub's runner API says that a runner is
# offline, never for how long. A runner whose host is down for an afternoon
# (the WSL box took every lane offline for three hours on 2026-09-03) looks
# exactly like a retired one, and removing its registration means registering
# it again by hand with a new token. GitHub already deletes a non-ephemeral
# runner that has not connected for 14 days, so what this script can add is
# speed, and the price of a wrong guess is a manual re-registration. The
# scheduled workflow therefore deletes only when the repository variable
# RUNNER_CLEANUP_APPLY is "true".
#
# Guards: a runner that is busy is never removed; if every runner in a scope is
# offline, that scope is treated as "the fleet is down", not "the fleet is
# stale", and nothing is removed from it; an unreadable or truncated listing is
# an error (exit 1) and removes nothing from that scope.
#
# The organization's runners are handled once, first. A repository's listing
# also shows the organization runners it can use, and those cannot be removed
# through the repository, so they are skipped there.
#
# GH_TOKEN needs the organization "self-hosted runners" permission (write) and
# the repository "Administration" permission (write). GH is overridable so the
# logic can be tested against a stub.
set -euo pipefail

cd "$(dirname "$0")/.."

GH="${GH:-gh}"
fleet_file="${1:-governance/repositories.txt}"

command -v jq >/dev/null || { echo "jq is required" >&2; exit 1; }
command -v "$GH" >/dev/null || { echo "gh CLI is required" >&2; exit 1; }
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
gh_api() { "$GH" api "$@" </dev/null; }

# Every runner of a scope as one JSON array; anything else is an error.
runners() {
  local out
  out="$(gh_api --paginate --slurp "$1/actions/runners?per_page=100")" || return 1
  jq -ce 'if all(.[]; type == "object" and (.runners | type) == "array") then [.[].runners[]] else error("not a runner list") end' <<<"$out"
}

seen_ids=" "
total_offline=0 total_removed=0

# $1 = API prefix (orgs/<org> or repos/<owner>/<repo>), $2 = label for output.
clean_scope() {
  local prefix="$1" label="$2" all online id name labels
  all="$(runners "$prefix")" || { fail "$label: cannot read the runner list in full"; return 0; }

  online="$(jq '[.[] | select(.status == "online")] | length' <<<"$all")"
  local total
  total="$(jq 'length' <<<"$all")"
  if [ "$total" -gt 0 ] && [ "$online" -eq 0 ]; then
    say "- $label: all $total runner(s) offline; the fleet looks down, so nothing is removed"
    return 0
  fi

  while IFS=$'\t' read -r id name labels; do
    [ -n "$id" ] || continue
    case "$seen_ids" in *" $id "*) continue ;; esac
    seen_ids="$seen_ids$id "
    total_offline=$((total_offline + 1))
    if [ "${APPLY:-0}" != "1" ]; then
      say "- plan: would remove offline runner $name ($labels) from $label"
      continue
    fi
    if gh_api -X DELETE "$prefix/actions/runners/$id" --silent; then
      say "- removed offline runner $name ($labels) from $label"
      total_removed=$((total_removed + 1))
    else
      fail "$label: could not remove runner '$name'"
    fi
  done < <(jq -r '.[] | select(.status == "offline" and (.busy | not)) | [.id, .name, ([.labels[].name] | join(","))] | @tsv' <<<"$all")
}

say "### Runner registration cleanup"
say ""

orgs=" "
repos=()
while read -r repo _ _; do
  case "$repo" in ''|'#'*) continue ;; esac
  if ! printf '%s' "$repo" | grep -Eq '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$'; then
    fail "malformed repository identifier: '${repo}'"
    continue
  fi
  case "$orgs" in *" ${repo%%/*} "*) ;; *) orgs="$orgs${repo%%/*} " ;; esac
  repos+=("$repo")
done < "$fleet_file"

for org in $orgs; do
  clean_scope "orgs/$org" "organization $org"
done
for repo in ${repos[@]+"${repos[@]}"}; do
  clean_scope "repos/$repo" "$repo"
done

say ""
if [ "${APPLY:-0}" = "1" ]; then
  say "Removed ${total_removed} of ${total_offline} offline runner(s)."
else
  say "Dry run: ${total_offline} offline runner(s) found. Nothing was changed. Set APPLY=1 to remove them."
fi
exit "$status"
