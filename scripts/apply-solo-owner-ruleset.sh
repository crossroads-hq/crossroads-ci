#!/usr/bin/env bash

set -euo pipefail

repo="${1:?Usage: $0 OWNER/REPOSITORY [BRANCH] [CHECK_CONTEXT]}"
branch="${2:-main}"
check_context="${3:-PR Validation}"
ruleset_name="Crossroads ${branch} protection"

command -v gh >/dev/null || { echo "gh CLI is required" >&2; exit 1; }
command -v jq >/dev/null || { echo "jq is required" >&2; exit 1; }
gh auth status >/dev/null 2>&1 || {
  echo "GitHub authentication is unavailable. Run: gh auth login -h github.com" >&2
  exit 1
}

payload=$(jq -n \
  --arg name "$ruleset_name" \
  --arg ref "refs/heads/${branch}" \
  --arg context "$check_context" \
  '{
    name: $name,
    target: "branch",
    enforcement: "active",
    conditions: { ref_name: { include: [$ref], exclude: [] } },
    rules: [
      { type: "deletion" },
      { type: "non_fast_forward" },
      { type: "pull_request", parameters: {
        required_approving_review_count: 0,
        dismiss_stale_reviews_on_push: false,
        require_code_owner_review: false,
        require_last_push_approval: false,
        required_reviewers: [],
        required_review_thread_resolution: true,
        allowed_merge_methods: ["merge", "squash", "rebase"]
      } },
      { type: "required_status_checks", parameters: {
        strict_required_status_checks_policy: true,
        do_not_enforce_on_create: false,
        required_status_checks: [{ context: $context }]
      } }
    ],
    bypass_actors: []
  }')

if [[ "${DRY_RUN:-0}" == "1" ]]; then
  printf '%s\n' "$payload"
  exit 0
fi

ruleset_id=$(gh api "repos/${repo}/rulesets" | jq -r --arg name "$ruleset_name" '.[] | select(.name == $name and .target == "branch") | .id' | head -n 1)

if [[ -n "$ruleset_id" ]]; then
  printf '%s' "$payload" | gh api \
    --method PUT \
    "repos/${repo}/rulesets/${ruleset_id}" \
    --input - \
    --silent
  echo "Updated ${ruleset_name} (${ruleset_id}) on ${repo}:${branch}"
else
  printf '%s' "$payload" | gh api \
    --method POST \
    "repos/${repo}/rulesets" \
    --input - \
    --silent
  echo "Created ${ruleset_name} on ${repo}:${branch}"
fi
