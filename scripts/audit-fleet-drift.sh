#!/usr/bin/env bash
#
# Ask the inverse of verify-fleet.sh.
#
# verify-fleet.sh asked "does every repository carry the ruleset its profile
# prescribes?" Under org rulesets targeting a custom property that is no longer
# a question worth asking -- the org answers it, and it cannot drift per
# repository. The useful question became "is anything ESCAPING inheritance?"
#
# Each check below exists because the thing it looks for actually happened
# during the 2026-09 migration, and each was invisible until someone looked:
#
#   - Seven of eleven runners were UNSELECTABLE. Their labels could not satisfy
#     any job's runs-on. They reported online and healthy for weeks.
#   - A repo-level ruleset silently overrode the org's, because rulesets are
#     ADDITIVE and the stricter rule wins. Adding the org ruleset changed
#     nothing and looked finished.
#   - A repo secret shadowed the org secret of the same name. Rotating the org
#     copy would have appeared to work and changed nothing.
#   - A production deploy failed `gh: command not found` after moving to a
#     capability label: the step assumed tooling one host happened to have.
#
# Exit 1 on anything in the MUST section, 0 otherwise. INFO findings are
# printed but never fail the run -- a check that cries wolf gets muted, and a
# muted audit is worse than none.

set -euo pipefail

ORG="${FLEET_ORG:-crossroads-hq}"
CONTROL_PLANE="${FLEET_CONTROL_PLANE:-crossroads-ci}"

command -v gh >/dev/null || { echo "gh CLI is required" >&2; exit 1; }
command -v jq >/dev/null || { echo "jq is required" >&2; exit 1; }

must=0
summary="${GITHUB_STEP_SUMMARY:-/dev/null}"

say()  { printf '%s\n' "$*"; printf '%s\n' "$*" >> "$summary"; }
fail() { must=1; say "- **MUST FIX** $*"; }
info() { say "- info — $*"; }

# `gh api` returns non-zero on 403, which `set -e` would turn into a silent
# abort halfway through the audit. Every org-scoped read is wrapped so a
# missing permission degrades that ONE check instead of killing the run: an
# audit that stops early while reporting success is the failure mode this
# whole script exists to catch.
try() { gh api "$@" 2>/dev/null || return 1; }

say "## Fleet drift audit — \`$ORG\`"
say ""

# ---------------------------------------------------------------- repositories
repos_json="$(try "orgs/$ORG/repos?per_page=100")" || {
  say "Could not list repositories for \`$ORG\`. The token needs org read access."
  exit 1
}
# Not `mapfile`: that is bash 4+, and macOS ships 3.2. This script is meant
# to run by hand as well as in CI, and the fleet now has a macOS lane.
repos=()
while IFS= read -r _r; do
  [ -n "$_r" ] && repos+=("$_r")
done <<<"$(jq -r '.[] | select(.archived == false) | .name' <<<"$repos_json")"
say "Auditing ${#repos[@]} non-archived repositories."
say ""

# ------------------------------------------------- 1. unclassified = ungoverned
say "### Classification"
props="$(try "orgs/$ORG/properties/values?per_page=100")" || props=""
if [ -z "$props" ]; then
  info "custom property values unreadable (token lacks org read); classification unchecked"
else
  for r in "${repos[@]}"; do
    profile="$(jq -r --arg r "$r" '.[] | select(.repository_name==$r) | .properties[] | select(.property_name=="fleet-profile") | .value // "none"' <<<"$props")"
    [ -z "$profile" ] && profile="unset"
    if [ "$profile" = "none" ] || [ "$profile" = "unset" ]; then
      fail "\`$r\` has \`fleet-profile=$profile\` — no org ruleset targets it, so it is ungoverned."
    fi
  done
fi

# ------------------------------------- 2. repo rulesets escape org governance
say ""
say "### Rulesets"
for r in "${repos[@]}"; do
  # source_type filters out the INHERITED org ruleset, which this endpoint
  # also returns. Without the filter every repository looks like a violation.
  local_rs="$(try "repos/$ORG/$r/rulesets" | jq -r '[.[] | select(.source_type != "Organization") | .name] | join(", ")' 2>/dev/null || true)"
  [ -n "${local_rs:-}" ] && fail "\`$r\` carries repo-level ruleset(s): ${local_rs}. Rulesets are additive and the stricter rule wins, so this silently overrides the org."
done

# --------------------------------------------- 3. repo secrets shadow org ones
say ""
say "### Secrets"
org_secrets="$(try "orgs/$ORG/actions/secrets" | jq -r '[.secrets[].name] | join("\n")' 2>/dev/null || true)"
if [ -z "${org_secrets:-}" ]; then
  info "org secrets unreadable; shadowing unchecked"
else
  for r in "${repos[@]}"; do
    repo_secrets="$(try "repos/$ORG/$r/actions/secrets" | jq -r '[.secrets[].name] | join("\n")' 2>/dev/null || true)"
    [ -z "${repo_secrets:-}" ] && continue
    while IFS= read -r name; do
      [ -z "$name" ] && continue
      if grep -qxF "$name" <<<"$org_secrets"; then
        fail "\`$r\` has a repo secret \`$name\` that shadows the org secret of the same name. The repo value wins; rotating the org copy would change nothing."
      fi
    done <<<"$repo_secrets"
  done
fi

# ------------------------------ 4. runs-on must name capability, not identity
say ""
say "### Runner selectors"
for r in "${repos[@]}"; do
  branch="$(try "repos/$ORG/$r" | jq -r .default_branch)" || continue
  files="$(try "repos/$ORG/$r/contents/.github/workflows?ref=$branch" | jq -r '.[]?.name' 2>/dev/null || true)"
  [ -z "${files:-}" ] && continue
  while IFS= read -r f; do
    [ -z "$f" ] && continue
    body="$(try "repos/$ORG/$r/contents/.github/workflows/$f?ref=$branch" | jq -r '.content' | base64 -d 2>/dev/null || true)"
    [ -z "${body:-}" ] && continue
    # A repository name in runs-on re-pins a job to one lane and defeats the
    # shared pool. An OS label (Linux/Windows/macOS/X64/ARM64) is auto-detected
    # and cannot be claimed, so it permanently excludes every other host --
    # the reason three retired Mac runners were never once scheduled.
    while IFS= read -r sel; do
      [ -z "$sel" ] && continue
      for bad in $(printf '%s\n' "${repos[@]}") Linux Windows macOS X64 ARM64; do
        case "$sel" in
          *"$bad"*) fail "\`$r/$f\`: \`$sel\` names \`$bad\`. Selectors should name capability (\`fast\`, \`light\`) only." ;;
        esac
      done
    done < <(grep -oE "runs-on: \[[^]]*\]" <<<"$body" || true)
  done <<<"$files"
done

# ----------------------------- 5. control-plane pins pointing at abandoned SHAs
say ""
say "### Control-plane pins"
cp_main="$(try "repos/$ORG/$CONTROL_PLANE/commits/main" | jq -r .sha)" || cp_main=""
if [ -z "$cp_main" ]; then
  info "could not read \`$CONTROL_PLANE\` main; pins unchecked"
else
  for r in "${repos[@]}"; do
    [ "$r" = "$CONTROL_PLANE" ] && continue
    branch="$(try "repos/$ORG/$r" | jq -r .default_branch)" || continue
    files="$(try "repos/$ORG/$r/contents/.github/workflows?ref=$branch" | jq -r '.[]?.name' 2>/dev/null || true)"
    [ -z "${files:-}" ] && continue
    while IFS= read -r f; do
      [ -z "$f" ] && continue
      body="$(try "repos/$ORG/$r/contents/.github/workflows/$f?ref=$branch" | jq -r '.content' | base64 -d 2>/dev/null || true)"
      while IFS= read -r sha; do
        [ -z "$sha" ] && continue
        # An ANCESTOR of main is a deliberate pin and fine. A SHA that is not
        # an ancestor points at an abandoned or rewritten commit -- which is
        # how one repository ended up pinned to a revision predating a fix
        # every other repository already had.
        st="$(try "repos/$ORG/$CONTROL_PLANE/compare/$sha...$cp_main" | jq -r '.status' 2>/dev/null || echo unknown)"
        case "$st" in
          ahead|identical) : ;;
          unknown) info "\`$r/$f\` pins \`${sha:0:8}\` — could not compare against \`$CONTROL_PLANE\` main." ;;
          *) fail "\`$r/$f\` pins \`${sha:0:8}\`, which is not an ancestor of \`$CONTROL_PLANE\` main (status: $st). Abandoned or rewritten pin." ;;
        esac
      done < <(grep -oE "$ORG/$CONTROL_PLANE[^@]*@[0-9a-f]{40}" <<<"${body:-}" | grep -oE "[0-9a-f]{40}$" | sort -u || true)
    done <<<"$files"
  done
fi

# ------------------------------------------- 6. host-tool assumptions (INFO)
say ""
say "### Host tooling on self-hosted jobs"
# Not a MUST: a tool may legitimately be present on every lane. But `gh` and
# `jq` were BOTH absent from the WSL lanes while present on the Mac, and the
# fleet moved from one to the other -- so any such call is worth a second look.
for r in "${repos[@]}"; do
  branch="$(try "repos/$ORG/$r" | jq -r .default_branch)" || continue
  files="$(try "repos/$ORG/$r/contents/.github/workflows?ref=$branch" | jq -r '.[]?.name' 2>/dev/null || true)"
  [ -z "${files:-}" ] && continue
  while IFS= read -r f; do
    [ -z "$f" ] && continue
    body="$(try "repos/$ORG/$r/contents/.github/workflows/$f?ref=$branch" | jq -r '.content' | base64 -d 2>/dev/null || true)"
    grep -q "runs-on: \[self-hosted" <<<"${body:-}" || continue
    for tool in gh jq yq shellcheck; do
      if grep -qE "^\s+.*[^a-zA-Z-]${tool} (api|pr|run|release|-r|-e|--version)" <<<"$body"; then
        info "\`$r/$f\` runs on self-hosted lanes and invokes \`$tool\`. Confirm every lane provides it."
      fi
    done
  done <<<"$files"
done

say ""
if [ "$must" -eq 0 ]; then
  say "**No must-fix drift.**"
else
  say "**Drift found.** Each MUST FIX above is something inheritance is not covering."
fi
exit "$must"
