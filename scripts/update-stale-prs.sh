#!/usr/bin/env bash
#
# Bring open pull requests that are behind the base branch up to date.
#
# The rulesets require a branch to be current with its base (strict required
# status checks), so every merge to main strands every other open PR behind a
# manual "Update branch" click. Auto-merge cannot get past that: it waits for
# the checks, and the checks wait for the update. This is that click.
#
#   REPO=owner/name BASE=main [MAX_UPDATES=2] scripts/update-stale-prs.sh
#
# Only a PR that has asked to merge is touched: open, not a draft, from this
# repository (never a fork), based on BASE, with auto-merge enabled. Updating
# every open PR re-runs CI and AI review on all of them after every merge, for
# work nobody is waiting on.
#
# MAX_UPDATES (optional, a positive integer; unset keeps the behaviour above)
# bounds how many of those PRs are kept current at once. With strict required
# checks only one PR can merge before the next merge strands the rest again, so
# updating every one of N PRs spends N validation runs to merge one. With the
# cap, the PRs are taken oldest auto-merge first and only the first
# MAX_UPDATES count; the rest wait for a later run, which every merge to the
# base branch starts. A PR does not count, and is passed over, when a check on
# its head has failed (a red PR at the front would otherwise stall everything
# behind it) or when it conflicts with the base (it is flagged for its author as
# below). A PR that is already current counts: it is in flight. A PR whose
# checks cannot be read is treated as not failing.
#
# Must run with a token that can push, and NOT GITHUB_TOKEN: the update is a
# push, and pushes made with GITHUB_TOKEN start no workflows, so the updated
# PR would never re-run PR Validation and would sit unmergeable.
#
# Exit 1 if the PR list may be incomplete, a PR's state could not be read, or
# an update failed for a reason other than a conflict or a race (an
# unrecognised 422 counts as a failure). A PR that
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

max_updates="${MAX_UPDATES:-}"
if [ -n "$max_updates" ] && ! [[ "$max_updates" =~ ^[1-9][0-9]*$ ]]; then
  echo "::error::MAX_UPDATES must be a positive integer or unset, not '$max_updates'."
  exit 1
fi

limit=200
err=$(mktemp)
if ! prs=$(gh pr list --repo "$REPO" --state open --base "$BASE" --limit "$limit" \
  --json number,isDraft,isCrossRepository,autoMergeRequest,headRefOid,labels,statusCheckRollup 2>"$err"); then
  echo "::error::Could not list open PRs: $(cat "$err")"
  echo "::error::A 'Resource not accessible by integration' naming statusCheckRollup means the token lacks Checks: read and Commit statuses: read. Grant them on the App and have the token request them (permission-checks, permission-statuses)."
  rm -f "$err"
  exit 1
fi
rm -f "$err"

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
  local marker="<!-- update-stale-prs:conflict $2 -->" bodies
  # Every page of PR comments, and a failed read is unknown state, not "no
  # marker": posting blind could duplicate the comment on each run.
  if ! bodies=$(gh api --paginate "repos/$REPO/issues/$1/comments" --jq '.[].body'); then
    echo "::error::PR #$1: could not read its comments to check for the conflict notice."
    return 1
  fi
  if ! grep -qF "$marker" <<<"$bodies"; then
    gh pr comment "$1" --repo "$REPO" --body "$marker
This branch conflicts with \`$BASE\`, so it cannot be updated automatically and auto-merge will stay blocked. Merge \`$BASE\` into it and resolve the conflicts, or run \`scripts/resolve-conflicts.sh $1\` from a checkout to have Claude do it." >/dev/null ||
      echo "::warning::PR #$1: could not post the conflict comment."
  fi
}

failed=0
updated=0
slots=0 # PRs counted against MAX_UPDATES
while IFS=$'\t' read -r number sha labelled failing; do
  if [ -n "$max_updates" ]; then
    if [ "$slots" -ge "$max_updates" ]; then
      echo "PR #$number: left for a later run ($max_updates PR(s) are ahead of it)."
      continue
    fi
    if [ "$failing" = "true" ]; then
      echo "PR #$number: passed over, a check on its head has failed."
      continue
    fi
  fi
  # Ahead-or-level PRs have behind_by 0. A response we cannot read is unknown.
  if ! behind=$(gh api "repos/$REPO/compare/$BASE...$sha" --jq '.behind_by') ||
    ! [[ "$behind" =~ ^[0-9]+$ ]]; then
    echo "::error::PR #$number: could not read how far behind $BASE it is."
    failed=1
    continue
  fi
  if [ "$behind" -eq 0 ]; then
    [ "$labelled" = "true" ] && clear_label "$number"
    slots=$((slots + 1))
    continue
  fi

  # expected_head_sha makes the update a no-op if the author pushed meanwhile.
  if out=$(gh api -X PUT "repos/$REPO/pulls/$number/update-branch" \
    -f "expected_head_sha=$sha" 2>&1); then
    echo "PR #$number: updated ($behind commit(s) behind $BASE)."
    updated=$((updated + 1))
    slots=$((slots + 1))
    [ "$labelled" = "true" ] && clear_label "$number"
  # gh prints "<message> (HTTP 422)": the message comes first, so match the
  # two independently. Only the two known 422s are benign; any other 422 is
  # unknown state and fails the run.
  elif grep -qi 'merge conflict' <<<"$out" && grep -q 'HTTP 422' <<<"$out"; then
    echo "::warning::PR #$number: conflicts with $BASE. Left for its author."
    flag_conflict "$number" "$sha" || failed=1
  elif grep -qi 'head sha' <<<"$out" && grep -q 'HTTP 422' <<<"$out"; then
    echo "::warning::PR #$number: not updated, it changed during the run."
    slots=$((slots + 1))
  else
    echo "::error::PR #$number: update failed: $out"
    failed=1
  fi
done < <(jq -r '
  # A check that has concluded badly. Cancelled and skipped runs are not
  # failures, and a missing rollup is unknown, which counts as not failing.
  def failing: any((.statusCheckRollup // [])[];
    ((.conclusion // "") as $c | ["FAILURE", "TIMED_OUT", "STARTUP_FAILURE", "ACTION_REQUIRED"] | index($c) != null)
    or ((.state // "") as $s | ["FAILURE", "ERROR"] | index($s) != null));
  [.[]
    | select(.isDraft == false and .isCrossRepository == false and .autoMergeRequest != null)]
  | sort_by([(.autoMergeRequest.enabledAt // "9999"), .number])
  | .[]
  | [.number, .headRefOid, (any(.labels[]; .name == "needs-rebase")), failing] | @tsv' <<<"$prs")

echo "Updated $updated pull request(s) of $count open against $BASE."
exit "$failed"
