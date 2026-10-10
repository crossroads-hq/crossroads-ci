#!/usr/bin/env bash
#
# Bring open pull requests that are behind the base branch up to date.
#
# The rulesets require a branch to be current with its base (strict required
# status checks), so every merge to main strands every other open PR behind a
# manual "Update branch" click. Auto-merge cannot get past that: it waits for
# the checks, and the checks wait for the update. This is that click.
#
#   REPO=owner/name BASE=main scripts/update-stale-prs.sh
#
# Only a PR that has asked to merge is touched: open, not a draft, from this
# repository (never a fork), based on BASE, with auto-merge enabled. Updating
# every open PR re-runs CI and AI review on all of them after every merge, for
# work nobody is waiting on.
#
# Must run with a token that can push, and NOT GITHUB_TOKEN: the update is a
# push, and pushes made with GITHUB_TOKEN start no workflows, so the updated
# PR would never re-run PR Validation and would sit unmergeable.
#
# Exit 1 if the PR list may be incomplete, a PR's state could not be read, or
# an update failed for a reason other than a conflict or a race. A PR that
# cannot be updated because it conflicts, or because it moved while this ran,
# is left alone: that one is its author's to resolve. A conflicting PR gets one
# comment per head commit and the `needs-rebase` label, which the next
# successful run (or a run that finds the PR current) removes, so it never
# fails silently. The comment names the PR's own head SHA; it is never built
# from PR-controlled text.

set -euo pipefail

: "${REPO:?REPO=owner/name is required}"
: "${BASE:?BASE=<branch> is required}"
: "${GH_TOKEN:?GH_TOKEN is required}"

limit=200
prs=$(gh pr list --repo "$REPO" --state open --base "$BASE" --limit "$limit" \
  --json number,isDraft,isCrossRepository,autoMergeRequest,headRefOid,labels)

# A truncated list is unknown state, not "nothing else is open".
count=$(jq 'length' <<<"$prs")
if [ "$count" -ge "$limit" ]; then
  echo "::error::Listed $count open PRs, the page limit; the rest were not checked."
  exit 1
fi

label=needs-rebase

clear_label() { # number
  gh pr edit "$1" --repo "$REPO" --remove-label "$label" >/dev/null ||
    echo "::warning::PR #$1: could not remove the $label label."
}

flag_conflict() { # number sha
  gh label create "$label" --repo "$REPO" --color d93f0b \
    --description "Conflicts with the base branch; auto-update skipped" \
    >/dev/null 2>&1 || true
  gh pr edit "$1" --repo "$REPO" --add-label "$label" >/dev/null ||
    echo "::warning::PR #$1: could not add the $label label."
  local marker="<!-- update-stale-prs:conflict $2 -->"
  if ! gh pr view "$1" --repo "$REPO" --json comments --jq '.comments[].body' |
    grep -qF "$marker"; then
    gh pr comment "$1" --repo "$REPO" --body "$marker
This branch conflicts with \`$BASE\`, so it cannot be updated automatically and auto-merge will stay blocked. Rebase or merge \`$BASE\` and resolve the conflicts." >/dev/null ||
      echo "::warning::PR #$1: could not post the conflict comment."
  fi
}

failed=0
updated=0
while IFS=$'\t' read -r number sha labelled; do
  # Ahead-or-level PRs have behind_by 0. A response we cannot read is unknown.
  if ! behind=$(gh api "repos/$REPO/compare/$BASE...$sha" --jq '.behind_by') ||
    ! [[ "$behind" =~ ^[0-9]+$ ]]; then
    echo "::error::PR #$number: could not read how far behind $BASE it is."
    failed=1
    continue
  fi
  if [ "$behind" -eq 0 ]; then
    [ "$labelled" = "true" ] && clear_label "$number"
    continue
  fi

  # expected_head_sha makes the update a no-op if the author pushed meanwhile.
  if out=$(gh api -X PUT "repos/$REPO/pulls/$number/update-branch" \
    -f "expected_head_sha=$sha" 2>&1); then
    echo "PR #$number: updated ($behind commit(s) behind $BASE)."
    updated=$((updated + 1))
    [ "$labelled" = "true" ] && clear_label "$number"
  elif grep -qi 'HTTP 422.*conflict' <<<"$out"; then
    echo "::warning::PR #$number: conflicts with $BASE. Left for its author."
    flag_conflict "$number" "$sha"
  elif grep -q 'HTTP 422' <<<"$out"; then
    echo "::warning::PR #$number: not updated, it changed during the run."
  else
    echo "::error::PR #$number: update failed: $out"
    failed=1
  fi
done < <(jq -r '.[]
  | select(.isDraft == false and .isCrossRepository == false and .autoMergeRequest != null)
  | [.number, .headRefOid, (any(.labels[]; .name == "needs-rebase"))] | @tsv' <<<"$prs")

echo "Updated $updated pull request(s) of $count open against $BASE."
exit "$failed"
