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
# is reported and left alone: that one is its author's to resolve.

set -euo pipefail

: "${REPO:?REPO=owner/name is required}"
: "${BASE:?BASE=<branch> is required}"
: "${GH_TOKEN:?GH_TOKEN is required}"

limit=200
prs=$(gh pr list --repo "$REPO" --state open --base "$BASE" --limit "$limit" \
  --json number,isDraft,isCrossRepository,autoMergeRequest,headRefOid)

# A truncated list is unknown state, not "nothing else is open".
count=$(jq 'length' <<<"$prs")
if [ "$count" -ge "$limit" ]; then
  echo "::error::Listed $count open PRs, the page limit; the rest were not checked."
  exit 1
fi

failed=0
updated=0
while IFS=$'\t' read -r number sha; do
  # Ahead-or-level PRs have behind_by 0. A response we cannot read is unknown.
  if ! behind=$(gh api "repos/$REPO/compare/$BASE...$sha" --jq '.behind_by') ||
    ! [[ "$behind" =~ ^[0-9]+$ ]]; then
    echo "::error::PR #$number: could not read how far behind $BASE it is."
    failed=1
    continue
  fi
  [ "$behind" -gt 0 ] || continue

  # expected_head_sha makes the update a no-op if the author pushed meanwhile.
  if out=$(gh api -X PUT "repos/$REPO/pulls/$number/update-branch" \
    -f "expected_head_sha=$sha" 2>&1); then
    echo "PR #$number: updated ($behind commit(s) behind $BASE)."
    updated=$((updated + 1))
  elif grep -q 'HTTP 422' <<<"$out"; then
    echo "::warning::PR #$number: not updated, it conflicts with $BASE or changed during the run. Left for its author."
  else
    echo "::error::PR #$number: update failed: $out"
    failed=1
  fi
done < <(jq -r '.[]
  | select(.isDraft == false and .isCrossRepository == false and .autoMergeRequest != null)
  | [.number, .headRefOid] | @tsv' <<<"$prs")

echo "Updated $updated pull request(s) of $count open against $BASE."
exit "$failed"
