#!/usr/bin/env bash
#
# Roll the stale-PR updater out to one fleet repository: the steps only an org
# owner can take (install the App on the repo, put its credentials in the repo's
# main-only `pr-updater` environment). Re-runnable per repository:
#
#   scripts/rollout-update-stale-prs.sh
#
# Generated with the /wizard skill; see README, "Stale PR updates".
#
# Everything above the "STAGES" marker is the wizard library: do not hand-edit
# it. Author the per-step stages below the marker.

# RED is part of the shared wizard library and is not used by every wizard.
# shellcheck disable=SC2034
set -euo pipefail

# ──────────────────────────────────────────────────────────────────────────
# Wizard library: delightful, consistent UX, identical across every wizard.
# ──────────────────────────────────────────────────────────────────────────

if [[ -t 1 ]] && command -v tput >/dev/null 2>&1 && [[ "$(tput colors 2>/dev/null || echo 0)" -ge 8 ]]; then
  BOLD=$(tput bold); DIM=$(tput dim); RESET=$(tput sgr0)
  BLUE=$(tput setaf 4); GREEN=$(tput setaf 2); YELLOW=$(tput setaf 3); RED=$(tput setaf 1)
else
  BOLD=""; DIM=""; RESET=""; BLUE=""; GREEN=""; YELLOW=""; RED=""
fi

# Author sets this at the top of the stages section.
TOTAL_STAGES=0

_STAGE_INDEX=0
ENV_FILE="${ENV_FILE:-.env}"
WRITTEN_ENV=()    # KEYs written to ENV_FILE this run
WRITTEN_SECRET=() # secret NAMEs set this run
SKIPPED=()        # things we couldn't do (e.g. gh missing)

# _clear wipes the terminal so only the current step is on screen. No-op when
# output isn't a terminal, so piped logs stay readable.
_clear() {
  [[ -t 1 ]] || return 0
  if command -v tput >/dev/null 2>&1; then tput clear; else printf '\033[2J\033[3J\033[H'; fi
}

# banner "Title" shows the opening frame: what this wizard does.
banner() {
  _clear
  printf '\n%s%s  %s%s\n' "$BOLD" "$BLUE" "$1" "$RESET"
  printf '%s  %s stages%s\n\n' "$DIM" "$TOTAL_STAGES" "$RESET"
  printf '%s  You drive the browser; this wizard tells you exactly what to do and\n' "$DIM"
  printf '  captures the values you copy back. Stop any time with Ctrl-C and re-run\n'
  printf '  later, since it remembers values already saved.%s\n' "$RESET"
  pause "Ready to start?"
}

# stage "Name" clears the screen, then announces a stage and shows progress.
# Clearing keeps only the current step on screen.
stage() {
  _clear
  _STAGE_INDEX=$((_STAGE_INDEX + 1))
  printf '\n%s%s▸ Stage %s/%s · %s%s\n' \
    "$BOLD" "$BLUE" "$_STAGE_INDEX" "$TOTAL_STAGES" "$1" "$RESET"
}

# say "..." prints a plain instruction line.
say()  { printf '  %s\n' "$1"; }
# step "..." is a numbered-feeling action the human takes in the browser.
step() { printf '  %s•%s %s\n' "$BLUE" "$RESET" "$1"; }
note() { printf '  %s%s%s\n' "$DIM" "$1" "$RESET"; }
warn() { printf '  %s⚠ %s%s\n' "$YELLOW" "$1" "$RESET"; }

# open_url URL opens it in the human's browser, cross-platform incl. WSL.
open_url() {
  local url="$1"
  printf '  %s↗ opening%s %s\n' "$GREEN" "$RESET" "$url"
  { if   command -v wslview     >/dev/null 2>&1; then wslview "$url"
    elif command -v explorer.exe >/dev/null 2>&1; then explorer.exe "$url"
    elif command -v xdg-open    >/dev/null 2>&1; then xdg-open "$url"
    elif command -v open        >/dev/null 2>&1; then open "$url"
    else warn "couldn't open a browser; visit it manually: $url"; fi
  } >/dev/null 2>&1 || warn "couldn't open a browser, so visit it manually: $url"
}

# pause "msg" waits for the human to confirm they've done the manual part.
pause() {
  printf '  %s%s%s ' "$DIM" "${1:-Press Enter to continue}" "$RESET"
  read -r _ || true
}

# confirm "question" is a y/N gate; returns success on yes.
confirm() {
  local reply=""
  printf '  %s? %s [y/N] ' "$YELLOW" "$1"
  read -r reply || true
  [[ "$reply" =~ ^[Yy] ]]
}

# _existing KEY: current value of KEY in ENV_FILE, if any.
_existing() {
  [[ -f "$ENV_FILE" ]] || return 1
  local line; line=$(grep -E "^${1}=" "$ENV_FILE" | tail -n1) || return 1
  printf '%s' "${line#*=}"
}

# ask KEY "Prompt" reads a value into $KEY. Offers the existing .env value as
# a default on re-runs (Enter keeps it). Visible input (non-secret).
ask() {
  local key="$1" prompt="$2" current input
  current=$(_existing "$key" || true)
  if [[ -n "$current" ]]; then
    printf '  %s%s%s %s[Enter keeps current]%s ' "$BOLD" "$prompt" "$RESET" "$DIM" "$RESET"
  else
    printf '  %s%s%s ' "$BOLD" "$prompt" "$RESET"
  fi
  read -r input || true
  [[ -z "$input" && -n "$current" ]] && input="$current"
  printf -v "$key" '%s' "$input"
}

# ask_secret KEY "Prompt" is like ask, but input is hidden.
ask_secret() {
  local key="$1" prompt="$2" current input
  current=$(_existing "$key" || true)
  if [[ -n "$current" ]]; then
    printf '  %s%s%s %s[Enter keeps current]%s ' "$BOLD" "$prompt" "$RESET" "$DIM" "$RESET"
  else
    printf '  %s%s%s ' "$BOLD" "$prompt" "$RESET"
  fi
  read -rs input || true
  printf '\n'
  [[ -z "$input" && -n "$current" ]] && input="$current"
  printf -v "$key" '%s' "$input"
}

# write_env KEY VALUE upserts KEY=VALUE into ENV_FILE (creates it; replaces
# any existing line). Idempotent.
write_env() {
  local key="$1" value="$2" tmp
  touch "$ENV_FILE"
  tmp=$(mktemp)
  grep -vE "^${key}=" "$ENV_FILE" > "$tmp" || true
  printf '%s=%s\n' "$key" "$value" >> "$tmp"
  mv "$tmp" "$ENV_FILE"
  WRITTEN_ENV+=("$key")
  printf '  %s✓ wrote%s %s → %s\n' "$GREEN" "$RESET" "$key" "$ENV_FILE"
}

# set_secret NAME VALUE sets a GitHub Actions repo secret via gh. Falls back
# to a warning (and records it) if gh is unavailable or unauthenticated.
set_secret() {
  local name="$1" value="$2"
  if command -v gh >/dev/null 2>&1 && gh auth status >/dev/null 2>&1; then
    if printf '%s' "$value" | gh secret set "$name" >/dev/null 2>&1; then
      WRITTEN_SECRET+=("$name")
      printf '  %s✓ set%s GitHub secret %s\n' "$GREEN" "$RESET" "$name"
      return
    fi
  fi
  SKIPPED+=("GitHub secret $name (set it manually: gh secret set $name)")
  warn "skipped GitHub secret $name: gh not ready; set it later"
}

# set_var NAME VALUE sets a GitHub Actions repo variable (non-secret).
set_var() {
  local name="$1" value="$2"
  if command -v gh >/dev/null 2>&1 && gh auth status >/dev/null 2>&1; then
    if gh variable set "$name" --body "$value" >/dev/null 2>&1; then
      printf '  %s✓ set%s GitHub variable %s\n' "$GREEN" "$RESET" "$name"
      return
    fi
  fi
  SKIPPED+=("GitHub variable $name")
  warn "skipped GitHub variable $name, gh not ready; set it later"
}

# finish clears, then shows a closing summary of everything configured.
finish() {
  _clear
  printf '\n%s%s  ✓ Setup complete%s\n' "$BOLD" "$GREEN" "$RESET"
  (( ${#WRITTEN_ENV[@]} ))    && note "wrote ${#WRITTEN_ENV[@]} value(s) to $ENV_FILE: ${WRITTEN_ENV[*]}"
  (( ${#WRITTEN_SECRET[@]} )) && note "set ${#WRITTEN_SECRET[@]} GitHub secret(s): ${WRITTEN_SECRET[*]}"
  if (( ${#SKIPPED[@]} )); then
    printf '\n'; warn "still to do by hand:"
    for s in "${SKIPPED[@]}"; do note "  - $s"; done
  fi
  printf '\n'
}

# ──────────────────────────────────────────────────────────────────────────
# STAGES
# ──────────────────────────────────────────────────────────────────────────

ORG=crossroads-hq
APP_SLUG=crossroads-ci-pr-updater
CONTROL="$ORG/crossroads-ci"
ENVNAME=pr-updater
SECRETS=(PR_UPDATER_APP_CLIENT_ID PR_UPDATER_APP_PRIVATE_KEY)

TOTAL_STAGES=4

# env_has_secret NAME: does the repository's environment hold it?
env_has_secret() {
  gh secret list --env "$ENVNAME" --repo "$ORG/$ROLL_REPO" --json name --jq '.[].name' 2>/dev/null |
    grep -qx "$1"
}

# env_is_main_only: the environment exists and allows deployments from main only.
env_is_main_only() {
  local out
  out=$(gh api "repos/$ORG/$ROLL_REPO/environments/$ENVNAME" \
    --jq '[.deployment_branch_policy.custom_branch_policies, .deployment_branch_policy.protected_branches] | @tsv' 2>/dev/null) || return 1
  [[ "$out" == $'true\tfalse' ]] || return 1
  [[ "$(gh api "repos/$ORG/$ROLL_REPO/environments/$ENVNAME/deployment-branch-policies" \
    --jq '[.branch_policies[].name] | join(",")' 2>/dev/null)" == "main" ]]
}

banner "Roll out stale-PR updates to a fleet repository"

# ── 1 ─────────────────────────────────────────────────────────────────────
stage "Check your setup and choose the repository"
command -v gh >/dev/null 2>&1 || { warn "gh is not installed."; exit 1; }
gh auth status >/dev/null 2>&1 || { warn "Run: gh auth login -h github.com"; exit 1; }
say "Why environments: a repository or organisation secret can be read by a workflow"
say "run from ANY branch, and this App's key can write to every repository it is"
say "installed on. In a main-only environment a branch run is refused the key."
printf '\n'
say "Repositories that gain from this are those on a full or full+tags profile:"
note "crossroads-agent-system  crossroads-ui  crossroads-evolution  hq  crossroads-os"
note "storybook-live-code-sandbox  storybook-live-code-addon"
printf '\n'
ask ROLL_REPO "Repository name, no owner (type it; there is no default):"
[[ -n "$ROLL_REPO" ]] || { warn "A repository name is required."; exit 1; }
ROLL_REPO_ID=$(gh api "repos/$ORG/$ROLL_REPO" --jq .id) ||
  { warn "Cannot read $ORG/$ROLL_REPO."; exit 1; }
INSTALL_ID=$(gh api "orgs/$ORG/installations" --paginate \
  --jq ".installations[] | select(.app_slug == \"$APP_SLUG\") | .id") ||
  { warn "Cannot list the org's App installations."; exit 1; }
[[ -n "$INSTALL_ID" ]] || { warn "The $APP_SLUG App is not installed on $ORG."; exit 1; }
perms=$(gh api "orgs/$ORG/installations" --paginate --jq \
  ".installations[] | select(.app_slug == \"$APP_SLUG\") | [.permissions.contents, .permissions.pull_requests, .permissions.workflows] | @tsv")
[[ "$perms" == $'write\twrite\twrite' ]] ||
  { warn "The App's installation lacks contents/pull-requests/workflows write ($perms). Approve the permission update first."; exit 1; }
printf '\n'
say "✓ $ORG/$ROLL_REPO found"
say "✓ App $APP_SLUG installed on the org with contents, pull-requests and workflows write"
if env_is_main_only; then say "✓ environment $ENVNAME exists and allows main only"
else say "• environment $ENVNAME is missing, or does not allow main only: stage 3 creates it"; fi
for s in "${SECRETS[@]}"; do
  if env_has_secret "$s"; then say "✓ environment secret $s is set"
  else say "• environment secret $s is not set"; fi
done
pause "Continue?"

# ── 2 ─────────────────────────────────────────────────────────────────────
stage "Install the App on $ROLL_REPO"
say "The App is installed on selected repositories only, so $ROLL_REPO has to be added."
open_url "https://github.com/organizations/$ORG/settings/installations/$INSTALL_ID"
step "Under 'Repository access' keep 'Only select repositories'."
step "Open the repository picker and add: $ROLL_REPO"
step "Click Save. The list should now include $ROLL_REPO."
note "Do not change the permissions here; they are already right."
confirm "Is $ROLL_REPO listed on that page?" || { warn "Re-run when it is."; exit 1; }

# ── 3 ─────────────────────────────────────────────────────────────────────
stage "Create the main-only environment and put the credentials in it"
say "Environment '$ENVNAME' in $ORG/$ROLL_REPO, allowing deployments from main only."
say "The two values go in as ENVIRONMENT secrets: not repository, not organisation."
printf '\n'
need_values=0
for s in "${SECRETS[@]}"; do env_has_secret "$s" || need_values=1; done
if (( need_values )); then
  open_url "https://github.com/organizations/$ORG/settings/apps/$APP_SLUG"
  step "About → copy the Client ID (starts Iv)."
  ask PU_CLIENT_ID "Paste the Client ID:"
  [[ "$PU_CLIENT_ID" == Iv* ]] || { warn "That does not look like a Client ID (expected Iv...)."; exit 1; }
  step "Use the .pem you keep in Infisical, or on this page: Private keys → Generate a private key"
  note "(it downloads a .pem; existing keys keep working, so this is safe to do)."
  ask PU_PEM_PATH "Path to the .pem file:"
  PU_PEM_PATH="${PU_PEM_PATH/#\~/$HOME}"
  if [[ ! -f "$PU_PEM_PATH" ]] || ! grep -q -- '-----BEGIN' "$PU_PEM_PATH"; then
    warn "That is not a PEM file."; exit 1
  fi
else
  say "Both environment secrets are already set; only the environment itself is checked."
fi
printf '\n'
confirm "Create/repair environment $ENVNAME (main only) and set the missing secrets in $ORG/$ROLL_REPO?" ||
  { warn "Nothing changed."; exit 1; }
gh api -X PUT "repos/$ORG/$ROLL_REPO/environments/$ENVNAME" --input - >/dev/null <<'JSON'
{"deployment_branch_policy":{"protected_branches":false,"custom_branch_policies":true}}
JSON
# Make the allowed branches exactly [main]: drop any other policy, add main.
for id in $(gh api "repos/$ORG/$ROLL_REPO/environments/$ENVNAME/deployment-branch-policies" \
  --jq '.branch_policies[] | select(.name != "main") | .id'); do
  gh api -X DELETE "repos/$ORG/$ROLL_REPO/environments/$ENVNAME/deployment-branch-policies/$id" >/dev/null
done
if ! gh api "repos/$ORG/$ROLL_REPO/environments/$ENVNAME/deployment-branch-policies" \
  --jq '.branch_policies[].name' | grep -qx main; then
  gh api -X POST "repos/$ORG/$ROLL_REPO/environments/$ENVNAME/deployment-branch-policies" \
    -f name=main -f type=branch >/dev/null
fi
printf '  %s✓ environment%s %s allows main only\n' "$GREEN" "$RESET" "$ENVNAME"
if ! env_has_secret PR_UPDATER_APP_CLIENT_ID; then
  printf '%s' "$PU_CLIENT_ID" | gh secret set PR_UPDATER_APP_CLIENT_ID --env "$ENVNAME" --repo "$ORG/$ROLL_REPO" >/dev/null
  WRITTEN_SECRET+=("PR_UPDATER_APP_CLIENT_ID (env $ENVNAME, $ROLL_REPO)")
fi
if ! env_has_secret PR_UPDATER_APP_PRIVATE_KEY; then
  gh secret set PR_UPDATER_APP_PRIVATE_KEY --env "$ENVNAME" --repo "$ORG/$ROLL_REPO" <"$PU_PEM_PATH" >/dev/null
  WRITTEN_SECRET+=("PR_UPDATER_APP_PRIVATE_KEY (env $ENVNAME, $ROLL_REPO)")
fi

# ── 4 ─────────────────────────────────────────────────────────────────────
stage "Verify, and get the caller to add"
ok=1
if env_is_main_only; then say "✓ environment $ENVNAME allows main only"
else warn "environment $ENVNAME does not allow main only"; ok=0; fi
for s in "${SECRETS[@]}"; do
  if env_has_secret "$s"; then say "✓ environment secret $s is set"
  else warn "environment secret $s is missing"; ok=0; fi
done
(( ok )) || { warn "Fix the above and re-run."; exit 1; }
leftover=0
for s in "${SECRETS[@]}"; do
  if gh api "orgs/$ORG/actions/secrets/$s/repositories" --jq '.repositories[].name' 2>/dev/null | grep -qx "$ROLL_REPO"; then
    leftover=1; SKIPPED+=("remove $ROLL_REPO from the visibility of org secret $s, once the caller below has merged and run (callers on the old pin still read it)")
  fi
  if gh secret list --repo "$ORG/$ROLL_REPO" --json name --jq '.[].name' 2>/dev/null | grep -qx "$s"; then
    leftover=1; SKIPPED+=("delete the repository-level secret $s in $ROLL_REPO, once the caller below has merged and run")
  fi
done
(( leftover )) && note "Old org/repo-level copies remain: they keep the key readable from any branch. See the list at the end."
PIN=$(gh api "repos/$CONTROL/commits/main" --jq .sha)
printf '\n'
say "What remains is a pull request in $ROLL_REPO. Ask Claude to do it, or set"
say ".github/workflows/update-stale-prs.yml to this (pin is crossroads-ci main now):"
printf '\n'
cat <<YAML
    name: Update stale PRs
    on:
      push:
        branches: [main]
      workflow_dispatch:
    permissions:
      contents: read
    jobs:
      update:
        uses: $CONTROL/.github/workflows/_update-stale-prs.yml@$PIN
        secrets: inherit
YAML
printf '\n'
note "Drop any 'with: runner-labels': that input no longer exists. After it merges: gh workflow run update-stale-prs.yml --repo $ORG/$ROLL_REPO --ref main"

finish
