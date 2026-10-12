#!/usr/bin/env bash
#
# Find, and with APPLY=1 remove, git worktrees (and their branches) that are
# finished with, in every git repository under the given folders. Meant for a
# developer machine, where `claude/*` and feature worktrees pile up:
#
#   scripts/clean-worktrees.sh ~/code            # list what would go, change nothing
#   APPLY=1 scripts/clean-worktrees.sh ~/code    # remove it
#
# Dry-run is the DEFAULT, like the other fleet scripts. Only `git` is needed,
# and it runs on macOS's bash 3.2.
#
# A linked worktree is removable only when ALL of these hold:
#   - it is not the repository's main worktree, not locked, and not the folder
#     (or a parent of the folder) this script was started from;
#   - it has a branch (a detached HEAD is reported and never removed);
#   - the branch is not the repository's default branch;
#   - it is clean: no modified, staged or untracked files;
#   - the branch is finished, meaning EITHER its upstream is gone after
#     `git fetch --prune` (the remote branch was deleted, which is what
#     delete-on-merge does) OR it is merged into the default branch and has
#     commits of its own. A branch sitting exactly at the default branch's tip is
#     kept: that is a branch created today as much as one merged long ago.
#
# Removing a worktree never loses commits, because the branch stays. The branch
# is then deleted with `git branch -d`, never -D: git refuses a branch it does
# not consider merged, which is the case for a squash-merged one, and the script
# says so and leaves it for you to check. Every removal prints the branch tip, so
# it can be put back with `git branch <name> <sha>`.
#
# Unknown state is not absence: a repository whose remote cannot be fetched is
# skipped (and the run exits 1), because "gone" cannot be told from "offline".
# A worktree whose folder is missing is listed with the command to prune it,
# never pruned here: it may live on a drive that is not mounted.
#
# GIT is overridable so the logic can be tested against a stub.
set -euo pipefail

GIT="${GIT:-git}"
MAX_DEPTH="${MAX_DEPTH:-3}"
FETCH="${FETCH:-1}"

command -v "$GIT" >/dev/null || { echo "git is required" >&2; exit 1; }
case "$MAX_DEPTH" in ''|*[!0-9]*) echo "MAX_DEPTH must be a whole number" >&2; exit 2;; esac

roots=("$@")
[ "${#roots[@]}" -gt 0 ] || roots=("$PWD")

start_dir="$(pwd -P)"
status=0
n_removable=0 n_removed=0 n_kept=0

say() { printf '%s\n' "$*"; }
warn() { printf 'WARNING: %s\n' "$*" >&2; status=1; }

# git without a terminal prompt or a pager, never reading our stdin.
g() { "$GIT" "$@" </dev/null; }

default_ref() {
  local repo="$1" ref
  for ref in "$(g -C "$repo" symbolic-ref -q --short refs/remotes/origin/HEAD 2>/dev/null || true)" \
             origin/main origin/master main master; do
    [ -n "$ref" ] || continue
    if g -C "$repo" rev-parse --verify -q "$ref^{commit}" >/dev/null 2>&1; then
      printf '%s\n' "$ref"
      return 0
    fi
  done
  return 1
}

# Prints why a worktree may go, or nothing when it stays. $5 says what to do
# with a branch: it only matters for the message.
clean_repo() {
  local repo="$1" default="" default_name="" default_tip
  local have_origin=0 path branch flags i
  local -a paths=() branches=() flagss=()

  if g -C "$repo" remote get-url origin >/dev/null 2>&1; then
    have_origin=1
    if [ "$FETCH" = "1" ] && ! g -C "$repo" fetch --prune --quiet origin >/dev/null 2>&1; then
      warn "$repo: cannot fetch origin; skipped, because a deleted remote branch cannot be told from being offline"
      return 0
    fi
  fi
  default="$(default_ref "$repo")" || default=""
  default_name="${default#origin/}"
  default_tip=""
  [ -z "$default" ] || default_tip="$(g -C "$repo" rev-parse "$default^{commit}")"

  # Collect the blocks first: running git inside the read loop is fragile.
  local line cur_path="" cur_branch="" cur_flags=""
  while IFS= read -r line; do
    case "$line" in
      "worktree "*) cur_path="${line#worktree }"; cur_branch=""; cur_flags="" ;;
      "branch refs/heads/"*) cur_branch="${line#branch refs/heads/}" ;;
      detached) cur_flags="$cur_flags detached" ;;
      bare) cur_flags="$cur_flags bare" ;;
      locked*) cur_flags="$cur_flags locked" ;;
      prunable*) cur_flags="$cur_flags prunable" ;;
      "")
        if [ -n "$cur_path" ]; then
          paths+=("$cur_path"); branches+=("$cur_branch"); flagss+=("$cur_flags")
        fi
        cur_path=""
        ;;
    esac
  done < <(g -C "$repo" worktree list --porcelain; echo)

  # The first block is the main worktree: never touched.
  [ "${#paths[@]}" -gt 1 ] || return 0
  say "$repo (default: ${default:-unknown})"

  for ((i = 1; i < ${#paths[@]}; i++)); do
    path="${paths[$i]}"; branch="${branches[$i]}"; flags="${flagss[$i]}"
    consider "$repo" "$path" "$branch" "$flags" "$default" "$default_name" "$default_tip" "$have_origin"
  done
}

keep() { say "  keep   $1 ($2)"; n_kept=$((n_kept + 1)); }

consider() {
  local repo="$1" path="$2" branch="$3" flags="$4" default="$5" default_name="$6" default_tip="$7"
  local tip track reason real

  case "$flags" in
    *prunable*) say "  missing $path (folder is gone; run: git -C '$repo' worktree prune)"; return 0 ;;
    *locked*)   keep "$path" "locked"; return 0 ;;
    *bare*)     return 0 ;;
  esac
  if [ ! -d "$path" ]; then
    say "  missing $path (folder is gone; run: git -C '$repo' worktree prune)"
    return 0
  fi
  real="$(cd "$path" && pwd -P)"
  case "$start_dir/" in "$real/"*) keep "$path" "you are in it"; return 0 ;; esac
  case "$flags" in *detached*) keep "$path" "detached HEAD, no branch to judge"; return 0 ;; esac
  if [ -z "$branch" ]; then keep "$path" "no branch"; return 0; fi
  if [ "$branch" = "$default_name" ]; then keep "$path" "default branch"; return 0; fi

  local dirty
  if ! dirty="$(g -C "$path" status --porcelain 2>/dev/null)"; then
    warn "$path: cannot read its status; kept"
    keep "$path" "status unreadable"
    return 0
  fi
  if [ -n "$dirty" ]; then keep "$path" "uncommitted or untracked files"; return 0; fi

  tip="$(g -C "$repo" rev-parse "refs/heads/$branch")"
  track="$(g -C "$repo" for-each-ref --format='%(upstream:track)' "refs/heads/$branch")"
  reason=""
  case "$track" in
    *gone*) reason="its remote branch is gone" ;;
    *)
      if [ -n "$default" ] && [ "$tip" != "$default_tip" ] \
         && g -C "$repo" merge-base --is-ancestor "$tip" "$default_tip" 2>/dev/null; then
        reason="merged into $default"
      fi
      ;;
  esac
  if [ -z "$reason" ]; then keep "$path" "branch '$branch' is not finished"; return 0; fi

  n_removable=$((n_removable + 1))
  if [ "${APPLY:-0}" != "1" ]; then
    say "  plan   would remove $path (branch '$branch' at $tip: $reason)"
    return 0
  fi
  if ! g -C "$repo" worktree remove -- "$path" 2>/dev/null; then
    warn "$path: git would not remove it; kept"
    return 0
  fi
  n_removed=$((n_removed + 1))
  if g -C "$repo" branch -d -- "$branch" >/dev/null 2>&1; then
    say "  removed $path and branch '$branch' (was $tip: $reason)"
  else
    say "  removed $path; branch '$branch' kept, git does not consider it merged (a squash merge looks like this). Check it, then: git -C '$repo' branch -D '$branch'   (tip $tip)"
  fi
}

for root in "${roots[@]}"; do
  if [ ! -d "$root" ]; then warn "no such folder: $root"; continue; fi
  while IFS= read -r -d '' gitdir; do
    clean_repo "$(dirname "$gitdir")"
  done < <(find "$root" -maxdepth "$MAX_DEPTH" -name node_modules -prune -o -name .git -type d -print0 -prune)
done

say ""
if [ "${APPLY:-0}" = "1" ]; then
  say "Removed ${n_removed} of ${n_removable} removable worktree(s), kept ${n_kept}."
else
  say "Dry run: ${n_removable} removable worktree(s), kept ${n_kept}. Nothing was changed. Set APPLY=1 to remove them."
fi
exit "$status"
