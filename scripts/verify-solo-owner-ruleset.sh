#!/usr/bin/env bash

set -euo pipefail

repo="${1:?Usage: $0 OWNER/REPOSITORY [BRANCH] [CHECK_CONTEXT]}"
branch="${2:-main}"
check_context="${3:-PR Validation}"
ruleset_name="Crossroads ${branch} protection"

command -v gh >/dev/null || { echo "gh CLI is required" >&2; exit 1; }
command -v jq >/dev/null || { echo "jq is required" >&2; exit 1; }

ruleset=$(gh api "repos/${repo}/rulesets" | jq -c --arg name "$ruleset_name" '.[] | select(.name == $name and .target == "branch")' | head -n 1)
[[ -n "$ruleset" ]] || { echo "missing active ruleset: ${ruleset_name}" >&2; exit 1; }

ruleset_id=$(jq -r '.id' <<<"$ruleset")
details=$(gh api "repos/${repo}/rulesets/${ruleset_id}")

jq -e \
  --arg ref "refs/heads/${branch}" \
  --arg context "$check_context" \
  '.enforcement == "active"
   and (.conditions.ref_name.include | index($ref)) != null
   and any(.rules[]; .type == "deletion")
   and any(.rules[]; .type == "non_fast_forward")
   and (any(.rules[]; .type == "pull_request" and .parameters.required_approving_review_count == 0 and .parameters.required_review_thread_resolution == true))
   and (any(.rules[]; .type == "required_status_checks" and .parameters.strict_required_status_checks_policy == true and ([.parameters.required_status_checks[].context] | index($context)) != null))' \
  <<<"$details" >/dev/null || {
    echo "ruleset does not match the solo-owner protection baseline: ${repo}:${branch}" >&2
    exit 1
  }

echo "Verified ${ruleset_name} on ${repo}:${branch}"
