#!/usr/bin/env bash

set -euo pipefail

repo_list="${1:?Usage: $0 REPOSITORY_LIST [BRANCH] [CHECK_CONTEXT]}"
branch="${2:-main}"
check_context="${3:-PR Validation}"
script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

[[ -f "$repo_list" ]] || { echo "repository list does not exist: $repo_list" >&2; exit 1; }
command -v gh >/dev/null || { echo "gh CLI is required" >&2; exit 1; }

while IFS= read -r repo || [[ -n "$repo" ]]; do
  repo="$(printf '%s' "$repo" | sed 's/^[[:space:]]*//; s/[[:space:]]*$//')"
  [[ -z "$repo" || "$repo" == \#* ]] && continue
  [[ "$repo" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || {
    echo "invalid repository identifier: $repo" >&2
    exit 1
  }

  echo "==> $repo:$branch"
  "$script_dir/apply-solo-owner-ruleset.sh" "$repo" "$branch" "$check_context"
  if [[ "${DRY_RUN:-0}" != "1" ]]; then
    "$script_dir/verify-solo-owner-ruleset.sh" "$repo" "$branch" "$check_context"
  fi
done < "$repo_list"
