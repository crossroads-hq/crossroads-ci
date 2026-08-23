#!/usr/bin/env bash

set -euo pipefail

repo="${1:-tsviser/crossroads-agent-system}"
branch="${2:-main}"

if [[ "${DRY_RUN:-0}" == "1" ]]; then
  echo "DRY RUN: would protect ${repo}:${branch}" >&2
fi

command -v gh >/dev/null || { echo "gh CLI is required" >&2; exit 1; }

payload=$(cat <<'JSON'
{
  "required_status_checks": {
    "strict": true,
    "contexts": ["validate"]
  },
  "enforce_admins": true,
  "required_pull_request_reviews": {
    "dismiss_stale_reviews": false,
    "require_code_owner_reviews": false,
    "required_approving_review_count": 0,
    "require_last_push_approval": false
  },
  "restrictions": null,
  "required_linear_history": false,
  "allow_force_pushes": false,
  "allow_deletions": false,
  "block_creations": false,
  "required_conversation_resolution": true,
  "lock_branch": false,
  "allow_fork_syncing": false
}
JSON
)

if [[ "${DRY_RUN:-0}" == "1" ]]; then
  printf '%s\n' "$payload"
  exit 0
fi

gh auth status >/dev/null 2>&1 || {
  echo "GitHub authentication is unavailable. Run: gh auth login -h github.com" >&2
  exit 1
}

printf '%s' "$payload" | gh api \
  --method PUT \
  "repos/${repo}/branches/${branch}/protection" \
  --input - \
  --silent

echo "Protected ${repo}:${branch}"
