#!/usr/bin/env bash
#
# Move one fleet App's key from repository secrets into its main-only
# environment, in crossroads-ci:
#
#   scripts/rollout-app-key-environments.sh [fleet-audit|branch-cleaner|runner-cleaner]
#
# These three Apps' keys are delivered by Infisical (sync ci-ci-prod) as
# REPOSITORY secrets of a public repository, readable from any branch. Each
# workflow job now names an environment (README, "Keys of the other three
# Apps"). This wizard does the owner's part for one App: generate a fresh key
# (which also rotates the old one out), put the key and Client ID in the
# environment, prove a run from main still works, stop the Infisical sync from
# re-creating the repository copies, delete those, delete the old key, and prove
# it works again. Re-runnable: it shows what is already done.
#
# Generated with the /wizard skill; see README, "Keys of the other three Apps".
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
REPO="$ORG/crossroads-ci"
TOTAL_STAGES=5

# Per App: GitHub App slug, environment, workflow file, secret prefix, and the
# `gh workflow run` flags for a harmless manual run (the cleaners are dry-run
# unless `apply` is ticked; the audit is read-only).
APPS=(fleet-audit branch-cleaner runner-cleaner)
app_field() { # APP FIELD
  case "$1:$2" in
    fleet-audit:slug) echo crossroads-ci-fleet-audit ;;
    branch-cleaner:slug) echo crossroads-ci-branch-cleaner ;;
    runner-cleaner:slug) echo crossroads-ci-runner-cleaner ;;
    fleet-audit:workflow) echo fleet-drift-audit.yml ;;
    branch-cleaner:workflow) echo branch-cleanup.yml ;;
    runner-cleaner:workflow) echo runner-cleanup.yml ;;
    fleet-audit:prefix) echo FLEET_AUDIT_APP ;;
    branch-cleaner:prefix) echo BRANCH_CLEANER_APP ;;
    runner-cleaner:prefix) echo RUNNER_CLEANER_APP ;;
    fleet-audit:runflags) echo "" ;;
    branch-cleaner:runflags) echo "-f apply=false" ;;
    runner-cleaner:runflags) echo "-f apply=false" ;;
  esac
}

env_has_secret() { # NAME
  gh secret list --env "$ENVNAME" --repo "$REPO" --json name --jq '.[].name' 2>/dev/null | grep -qx "$1"
}
repo_has_secret() { # NAME
  gh secret list --repo "$REPO" --json name --jq '.[].name' 2>/dev/null | grep -qx "$1"
}
# env_is_main_only: exists, custom policies only, and the one allowed branch is main.
env_is_main_only() {
  local out
  out=$(gh api "repos/$REPO/environments/$ENVNAME" \
    --jq '[.deployment_branch_policy.custom_branch_policies, .deployment_branch_policy.protected_branches] | @tsv' 2>/dev/null) || return 1
  [[ "$out" == $'true\tfalse' ]] || return 1
  [[ "$(gh api "repos/$REPO/environments/$ENVNAME/deployment-branch-policies" \
    --jq '[.branch_policies[].name] | join(",")' 2>/dev/null)" == "main" ]]
}
# main_names_environment: the workflow on main declares this environment. Until it
# does, nothing here protects anything, and deleting the repository copies would
# break the workflow.
main_names_environment() {
  gh api "repos/$REPO/contents/.github/workflows/$WORKFLOW?ref=main" --jq .content 2>/dev/null |
    base64 -d 2>/dev/null | grep -qE "^[[:space:]]+environment:[[:space:]]+${ENVNAME}[[:space:]]*\$"
}
# run_from_main: run the workflow from main as a dry run and wait for the result.
run_from_main() {
  local before id
  before=$(gh run list --repo "$REPO" --workflow "$WORKFLOW" --branch main --event workflow_dispatch --limit 1 --json databaseId --jq '.[0].databaseId // 0')
  # shellcheck disable=SC2086
  gh workflow run "$WORKFLOW" --repo "$REPO" --ref main $RUNFLAGS >/dev/null || return 1
  id=0
  for _ in $(seq 1 30); do
    sleep 3
    id=$(gh run list --repo "$REPO" --workflow "$WORKFLOW" --branch main --event workflow_dispatch --limit 1 --json databaseId --jq '.[0].databaseId // 0')
    [[ "$id" != "$before" && "$id" != 0 ]] && break
  done
  [[ "$id" != "$before" && "$id" != 0 ]] || { warn "The run did not start."; return 1; }
  note "Watching run $id (https://github.com/$REPO/actions/runs/$id)"
  gh run watch "$id" --repo "$REPO" --exit-status >/dev/null 2>&1
}

banner "Move a fleet App's key into its main-only environment"

# ── 1 ─────────────────────────────────────────────────────────────────────
stage "Check your setup and choose the App"
command -v gh >/dev/null 2>&1 || { warn "gh is not installed."; exit 1; }
gh auth status >/dev/null 2>&1 || { warn "Run: gh auth login -h github.com"; exit 1; }
say "Why: a repository secret in this public repository can be read by a workflow run"
say "from ANY branch, and a branch can delete the 'if: main' guard from its own copy of"
say "a workflow. In a main-only environment a branch run is refused the key."
printf '\n'
if [[ -n "${1:-}" ]]; then APP="$1"; else
  say "Apps: ${APPS[*]}"
  ask APP "Which App? (type one; there is no default)"
fi
case " ${APPS[*]} " in *" $APP "*) ;; *) warn "Unknown App '$APP'."; exit 1 ;; esac
ENVNAME="$APP"
SLUG=$(app_field "$APP" slug); WORKFLOW=$(app_field "$APP" workflow)
PREFIX=$(app_field "$APP" prefix); RUNFLAGS=$(app_field "$APP" runflags)
ID_NAME="${PREFIX}_CLIENT_ID"; KEY_NAME="${PREFIX}_PRIVATE_KEY"
printf '\n'
say "App $SLUG → environment $ENVNAME → workflow $WORKFLOW"
if main_names_environment; then say "✓ $WORKFLOW on main names the environment $ENVNAME"
else
  warn "$WORKFLOW on main does not name environment $ENVNAME yet."
  say "Merge the pull request that adds it first (README, 'Keys of the other three Apps'),"
  say "then re-run. Until then nothing here would protect the key, and deleting the"
  say "repository copies would break the workflow."
  exit 1
fi
if env_is_main_only; then say "✓ environment $ENVNAME exists and allows main only"
else say "• environment $ENVNAME is missing, or does not allow main only: stage 3 repairs it"; fi
for s in "$ID_NAME" "$KEY_NAME"; do
  if env_has_secret "$s"; then say "✓ environment secret $s is set"; else say "• environment secret $s is not set"; fi
  if repo_has_secret "$s"; then say "• repository secret $s still exists (stage 5 removes it)"; else say "✓ no repository secret $s"; fi
done
pause "Continue?"

# ── 2 ─────────────────────────────────────────────────────────────────────
stage "Generate a fresh private key"
need_values=0
for s in "$ID_NAME" "$KEY_NAME"; do env_has_secret "$s" || need_values=1; done
if (( need_values )); then
  say "A new key replaces the old one, which was readable from any branch: this is also"
  say "the rotation. Existing keys keep working until you delete them in stage 5."
  APP_CLIENT_ID=$(gh api "apps/$SLUG" --jq .client_id 2>/dev/null || true)
  if [[ "${APP_CLIENT_ID:-}" == Iv* ]]; then
    say "✓ Client ID $APP_CLIENT_ID (from the App's public page)"
  else
    open_url "https://github.com/organizations/$ORG/settings/apps/$SLUG"
    step "About → copy the Client ID (starts Iv)."
    ask APP_CLIENT_ID "Paste the Client ID:"
    [[ "$APP_CLIENT_ID" == Iv* ]] || { warn "That does not look like a Client ID (expected Iv...)."; exit 1; }
  fi
  PEM_PATH=""
  for f in "$HOME/Downloads/${SLUG}".*.private-key.pem; do
    [[ -f "$f" ]] || continue
    if [[ -z "$PEM_PATH" || "$f" -nt "$PEM_PATH" ]]; then PEM_PATH="$f"; fi
  done
  if [[ -n "$PEM_PATH" ]]; then
    say "Found a key file for this App: $PEM_PATH"
    note "Use it only if you generated it just now; an older file is a key you may have used elsewhere."
    confirm "Use it?" || PEM_PATH=""
  fi
  if [[ -z "$PEM_PATH" ]]; then
    open_url "https://github.com/organizations/$ORG/settings/apps/$SLUG"
    step "Private keys → Generate a private key (it downloads a .pem)."
    ask PEM_PATH "Path to the .pem file, including the filename:"
  fi
  PEM_PATH="${PEM_PATH/#\~/$HOME}"
  if [[ ! -f "$PEM_PATH" ]] || ! grep -q -- '-----BEGIN' "$PEM_PATH"; then
    warn "That is not a PEM file (is it a folder, or missing the filename?)."; exit 1
  fi
else
  say "Both environment secrets are already set; nothing to generate."
fi

# ── 3 ─────────────────────────────────────────────────────────────────────
stage "Put the credentials in the environment"
say "Environment '$ENVNAME' in $REPO, allowing deployments from main only."
say "The two values go in as ENVIRONMENT secrets, which override the repository ones."
note "If you already created the Infisical folder and its environment sync (README, 'Keys of the other three Apps'),"
note "the secrets are there and this stage only checks the environment. Setting them by hand is the fallback."
printf '\n'
confirm "Create/repair environment $ENVNAME (main only) and set the missing secrets?" ||
  { warn "Nothing changed."; exit 1; }
gh api -X PUT "repos/$REPO/environments/$ENVNAME" --input - >/dev/null <<'JSON'
{"deployment_branch_policy":{"protected_branches":false,"custom_branch_policies":true}}
JSON
for id in $(gh api "repos/$REPO/environments/$ENVNAME/deployment-branch-policies" \
  --jq '.branch_policies[] | select(.name != "main") | .id'); do
  gh api -X DELETE "repos/$REPO/environments/$ENVNAME/deployment-branch-policies/$id" >/dev/null
done
if ! gh api "repos/$REPO/environments/$ENVNAME/deployment-branch-policies" --jq '.branch_policies[].name' | grep -qx main; then
  gh api -X POST "repos/$REPO/environments/$ENVNAME/deployment-branch-policies" -f name=main -f type=branch >/dev/null
fi
env_is_main_only || { warn "The environment does not allow main only."; exit 1; }
printf '  %s✓ environment%s %s allows main only\n' "$GREEN" "$RESET" "$ENVNAME"
if ! env_has_secret "$ID_NAME"; then
  printf '%s' "$APP_CLIENT_ID" | gh secret set "$ID_NAME" --env "$ENVNAME" --repo "$REPO" >/dev/null
  WRITTEN_SECRET+=("$ID_NAME (env $ENVNAME)")
fi
if ! env_has_secret "$KEY_NAME"; then
  gh secret set "$KEY_NAME" --env "$ENVNAME" --repo "$REPO" <"$PEM_PATH" >/dev/null
  WRITTEN_SECRET+=("$KEY_NAME (env $ENVNAME)")
fi
if ! { env_has_secret "$ID_NAME" && env_has_secret "$KEY_NAME"; }; then warn "An environment secret is missing."; exit 1; fi
say "✓ both environment secrets are set"
note "The downloaded .pem is still on disk: delete it once stage 4 passes."

# ── 4 ─────────────────────────────────────────────────────────────────────
stage "Prove a run from main works"
say "A manual run of $WORKFLOW from main${RUNFLAGS:+ ($RUNFLAGS: a dry run, nothing is deleted)}."
note "The repository copies still exist, so this shows the workflow runs, not yet which copy it used."
confirm "Run it now?" || { warn "Re-run when ready."; exit 1; }
run_from_main || { warn "The run failed or did not finish. Open the run above, fix it, and re-run."; exit 1; }
say "✓ the run succeeded"

# ── 5 ─────────────────────────────────────────────────────────────────────
stage "Retire the repository copies and the old key"
say "Order matters: stop the sync that writes the repository copies first, or it"
say "re-creates them. Then delete them, then the old key, then prove it again."
printf '\n'
say "1. Infisical (project crossroads-ci, Production). One sync maps one folder to one"
say "   destination, so each App needs its own folder and its own environment sync:"
step "Folder /$APP holding $ID_NAME and $KEY_NAME (the key as one line, each line break written as \n)."
step "Integrations → Secret Syncs → Add Sync → GitHub: source Production /$APP; destination the"
step "same GitHub connection as ci-ci-prod, scope Repository Environment, repository crossroads-ci,"
step "environment $ENVNAME; auto-sync on, initial sync overwrite, secret deletion off; name ci-$APP-prod."
step "Remove those two secrets from the /ci folder, so ci-ci-prod stops carrying them."
note "Secrets set by hand in stage 3 are 'manual' against crossroads-os ADR-0005; the sync above is what makes them Infisical's."
note "If Infisical still held the OLD key for this environment, its next sync would overwrite the new one."
confirm "Is $ENVNAME delivered by its own sync, and /ci no longer carrying those two?" ||
  { warn "Do that first, then re-run; nothing has been deleted."; exit 1; }
printf '\n'
for s in "$ID_NAME" "$KEY_NAME"; do
  if repo_has_secret "$s"; then
    if confirm "Delete the repository-level secret $s from $REPO?"; then
      gh secret delete "$s" --repo "$REPO" >/dev/null && say "✓ deleted $s"
    else SKIPPED+=("delete repository secret $s in $REPO"); fi
  else say "✓ no repository secret $s"; fi
done
printf '\n'
open_url "https://github.com/organizations/$ORG/settings/apps/$SLUG"
step "Private keys: delete every key except the one you generated in stage 2 (the newest)."
note "The new key's fingerprint is the one added today. Deleting the old keys is what makes the earlier exposure harmless."
confirm "Only the new key is left on the App?" || SKIPPED+=("delete the old private key(s) of $SLUG")
printf '\n'
if confirm "Run $WORKFLOW from main once more, now that only the environment copy remains?"; then
  if run_from_main; then say "✓ it works from the environment's secrets alone"
  else
    warn "It failed. The environment secrets are the only copy now: re-run this wizard to repair them."
    SKIPPED+=("fix the failed run of $WORKFLOW")
  fi
else SKIPPED+=("run $WORKFLOW from main to confirm the environment secrets alone work"); fi
note "Delete the downloaded .pem from your machine."

finish
