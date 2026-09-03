#!/usr/bin/env bash
#
# Ask what is ESCAPING inheritance.
#
# The retired verify-fleet.sh asked "does every repository carry the ruleset
# its profile prescribes?" Under org rulesets targeting a custom property that
# stopped being answerable -- the org answers it, there is no per-repository
# ruleset to compare, and the script reported DIVERGED for the whole fleet. It
# was removed 2026-09-04; this is the question that replaced it.
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
#   - The reviewed fleet list and the org disagreed in BOTH directions, and
#     every script reported clean. Four entries named repositories the org
#     does not hold -- still owned by the pre-migration account -- and
#     verify-pins.sh read each 404 as "no workflows (minimal: expected)".
#     Two repositories the org governs by custom property were absent from
#     the reviewed list, so apply-fleet.sh and verify-pins.sh both skipped
#     them. Neither list could see either fault alone.
#
# Which list drives what: governance/repositories.txt, the REVIEWED fleet, is
# what every check below the classification section walks -- taking that list
# from the org API made this script a second, unreviewed roster beside the
# checked-in one, which is the drift it exists to find. The org listing is read
# only so the classification section can reconcile the two.
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

# Paginated variant. `gh api` fetches ONE page unless told otherwise, so a
# `?per_page=100` list silently truncates at 100 and the audit reports "no
# drift" for everything past it -- the same failure as aborting early, just
# quiet instead of loud. --slurp yields an array of pages, flattened with
# `.[][]` by callers, the house pattern the fleet scripts share.
tryp() { gh api --paginate --slurp "$@" 2>/dev/null || return 1; }

# Both runs-on spellings must be seen. Only the flow form was scanned at
# first, so a job written as a YAML block sequence --
#
#   runs-on:
#     - self-hosted
#     - some-repo-name
#
# -- escaped the identity check entirely. A selector style invisible to the
# audit is the same failure as the drift it looks for.
normalise_runs_on() {
  awk '
    /^[[:space:]]*runs-on:[[:space:]]*\[/ { print; next }
    /^[[:space:]]*runs-on:[[:space:]]*$/   { collecting=1; n=0; next }
    collecting && /^[[:space:]]*-[[:space:]]*/ {
      item=$0; sub(/^[[:space:]]*-[[:space:]]*/,"",item); gsub(/[\"'"'"']/,"",item)
      items[n++]=item; next
    }
    collecting {
      if (n>0) { out=""; for(i=0;i<n;i++) out=out (i?", ":"") items[i]; print "runs-on: [" out "]" }
      collecting=0; n=0
    }
    END { if (collecting && n>0) { out=""; for(i=0;i<n;i++) out=out (i?", ":"") items[i]; print "runs-on: [" out "]" } }
  ' <<<"$1"
}

say "## Fleet drift audit — \`$ORG\`"
say ""

# ---------------------------------------------------------------- repositories
#
# TWO lists, deliberately, and the difference between them is a finding.
#
# governance/repositories.txt is the REVIEWED fleet: the list apply-fleet.sh
# and verify-pins.sh already read, and the one a change has to
# pass a governance decision to reach. Every check below the classification
# section asks a question about the GOVERNED fleet, so it walks that list.
# Taking the roster from the org API instead made this script a second,
# unreviewed fleet roster beside the checked-in one -- the exact drift it
# exists to find, in itself -- and it silently disagreed with the reviewed one
# in both directions (see the classification section).
#
# The org listing is still read, because reconciling the two IS the
# classification check. Neither list can answer "what is escaping governance?"
# alone: the roster cannot name a repository nobody added to it, and the org
# cannot say which repositories were reviewed.
fleet_file="${1:-governance/repositories.txt}"
[ -r "$fleet_file" ] || { echo "cannot read fleet list: $fleet_file" >&2; exit 1; }

repos_json="$(tryp "orgs/$ORG/repos?per_page=100" | jq '[.[][]]')" || {
  say "Could not list repositories for \`$ORG\`. The token needs org read access."
  exit 1
}
org_live="$(jq -r '.[] | select(.archived == false) | .name' <<<"$repos_json")"
org_all="$(jq -r '.[] | .name' <<<"$repos_json")"

# Parsed the way apply-fleet.sh and verify-pins.sh already parse it, so the
# scripts cannot disagree about what the file means. Held as a
# tab-separated string rather than an associative array: those are bash 4+,
# macOS ships 3.2, and this script is meant to run by hand as well as in CI.
roster=""
roster_foreign=""
while read -r repo profile branch _; do
  case "$repo" in ''|'#'*) continue ;; esac
  case "$repo" in
    "$ORG"/*) roster="${roster}${repo#"$ORG"/}	${profile}
" ;;
    # An entry owned by someone else is not auditable here and must not be
    # silently skipped: it is either a genuine cross-org entry this audit
    # cannot see, or a roster line the migration missed.
    *) roster_foreign="${roster_foreign}${repo}
" ;;
  esac
done < "$fleet_file"

roster_names="$(printf '%s' "$roster" | cut -f1)"
roster_profile() { printf '%s' "$roster" | awk -F'\t' -v n="$1" '$1==n {print $2; exit}'; }

# The auditable set: reviewed AND actually present, non-archived, in this org.
# Roster entries that fail either half are reported below rather than walked --
# every per-repository check would only 404 on them.
repos=()
while IFS= read -r _r; do
  [ -n "$_r" ] || continue
  grep -qxF "$_r" <<<"$org_live" && repos+=("$_r")
done <<<"$roster_names"

say "Auditing ${#repos[@]} of $(grep -c . <<<"$roster_names") reviewed repositories; \`$ORG\` holds $(grep -c . <<<"$org_live") non-archived."
say ""

# --------------------------------------- 1. the two lists must name one fleet
say "### Classification"

while IFS= read -r _r; do
  [ -n "$_r" ] || continue
  if grep -qxF "$_r" <<<"$org_live"; then continue; fi
  if grep -qxF "$_r" <<<"$org_all"; then
    fail "\`$_r\` is on the reviewed list but ARCHIVED. Archiving supersedes any ruleset; unarchive before governing it, or remove the entry."
  else
    fail "\`$_r\` is on the reviewed list but \`$ORG\` has no such repository. Every per-repository check keys on gh's exit status, and a 404 for a name that does not exist is indistinguishable from \"nothing to check here\" -- verify-pins.sh reports such an entry as \"no workflows (minimal: expected)\" and exits 0."
  fi
done <<<"$roster_names"

while IFS= read -r _r; do
  [ -n "$_r" ] || continue
  fail "\`$_r\` is on the reviewed list under another owner, so this audit cannot see it. Either the migration missed the line, or it belongs to an org this run does not audit."
done <<<"$roster_foreign"

props="$(tryp "orgs/$ORG/properties/values?per_page=100" | jq '[.[][]]')" || props=""
if [ -z "$props" ]; then
  info "custom property values unreadable (token lacks org read); classification unchecked"
else
  while IFS= read -r _r; do
    [ -n "$_r" ] || continue
    profile="$(jq -r --arg r "$_r" '.[] | select(.repository_name==$r) | .properties[] | select(.property_name=="fleet-profile") | .value // "none"' <<<"$props")"
    [ -z "$profile" ] && profile="unset"

    if [ "$profile" = "none" ] || [ "$profile" = "unset" ]; then
      fail "\`$_r\` has \`fleet-profile=$profile\` — no org ruleset targets it, so it is ungoverned."
      continue
    fi

    # Governed by the org, absent from the reviewed list. The org ruleset
    # protects it, so nothing looks wrong from GitHub's side -- but
    # apply-fleet.sh and verify-pins.sh both walk the reviewed list, so no
    # script this repository ships ever checks it.
    if ! grep -qxF "$_r" <<<"$roster_names"; then
      fail "\`$_r\` carries \`fleet-profile=$profile\` but is not in ${fleet_file}, so every script that walks the reviewed list skips it. Add it with a profile, or set the property to \`none\` if it is deliberately ungoverned."
      continue
    fi

    # `full+tags` is how the roster spells what the custom property calls
    # `full-tags`; the property is a single-select and its allowed values
    # cannot carry the `+`. Any other disagreement is two sources of truth
    # prescribing different rulesets for one repository.
    want="$(roster_profile "$_r")"
    case "$want" in full+tags) want="full-tags" ;; esac
    if [ "$want" != "$profile" ]; then
      fail "\`$_r\` is \`$(roster_profile "$_r")\` in ${fleet_file} but \`fleet-profile=$profile\` in the org. The org property decides which ruleset applies; the file decides what apply-fleet.sh writes."
    fi
  done <<<"$org_live"
fi

# ------------------------------------- 2. repo rulesets escape org governance
say ""
say "### Rulesets"
for r in "${repos[@]}"; do
  # source_type filters out the INHERITED org ruleset, which this endpoint
  # also returns. Without the filter every repository looks like a violation.
  rs_raw="$(try "repos/$ORG/$r/rulesets")" || { info "\`$r\` rulesets unreadable — NOT checked for local overrides."; continue; }
  local_rs="$(jq -r '[.[] | select(.source_type != "Organization") | .name] | join(", ")' <<<"$rs_raw" 2>/dev/null || true)"
  [ -n "${local_rs:-}" ] && fail "\`$r\` carries repo-level ruleset(s): ${local_rs}. Rulesets are additive and the stricter rule wins, so this silently overrides the org."
done

# --------------------------------------------- 3. repo secrets shadow org ones
say ""
say "### Secrets"
# Paginated, like every other org list read. This endpoint returns an object
# rather than a bare array, so --slurp yields one object per page and the names
# are flattened out of each page's `.secrets` -- an unpaginated read stopped at
# 30 and reported the fleet clean of shadowing past it.
org_secrets="$(tryp "orgs/$ORG/actions/secrets" | jq -r '[.[].secrets[].name] | join("\n")' 2>/dev/null || true)"
if [ -z "${org_secrets:-}" ]; then
  info "org secrets unreadable; shadowing unchecked"
else
  for r in "${repos[@]}"; do
    # Paginated for the same reason as the org read above: this is the other
    # half of the same comparison, and truncating either side hides shadowing.
    repo_secrets="$(tryp "repos/$ORG/$r/actions/secrets" | jq -r '[.[].secrets[].name] | join("\n")' 2>/dev/null || true)"
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
  branch="$(try "repos/$ORG/$r" | jq -r .default_branch)" || { info "\`$r\` metadata unreadable — selectors NOT checked."; continue; }
  files="$(try "repos/$ORG/$r/contents/.github/workflows?ref=$branch" | jq -r '.[]?.name' 2>/dev/null || true)"
  [ -z "${files:-}" ] && continue
  while IFS= read -r f; do
    [ -z "$f" ] && continue
    body="$(try "repos/$ORG/$r/contents/.github/workflows/$f?ref=$branch" | jq -r '.content' | base64 -d 2>/dev/null || true)"
    [ -z "${body:-}" ] && { info "\`$r/$f\` unreadable — selectors NOT checked."; continue; }
    # A repository name in runs-on re-pins a job to one lane and defeats the
    # shared pool. An OS label (Linux/Windows/macOS/X64/ARM64) is auto-detected
    # and cannot be claimed, so it permanently excludes every other host --
    # the reason three retired Mac runners were never once scheduled.
    #
    # Compared as TOKENS, not substrings. `case $sel in *"$bad"*` would flag
    # every `[self-hosted, light]` in the fleet the day someone creates a
    # repository named `light` -- crying wolf on the whole fleet, which is the
    # failure this script's INFO/MUST split exists to avoid.
    while IFS= read -r sel; do
      [ -z "$sel" ] && continue
      inner="${sel#*[}"; inner="${inner%]}"
      old_ifs="$IFS"; IFS=','
      # shellcheck disable=SC2086  # deliberate split on the comma-separated list
      set -- $inner
      IFS="$old_ifs"
      for tok in "$@"; do
        tok="$(printf '%s' "$tok" | tr -d "[:space:]\"'")"
        [ -z "$tok" ] && continue
        for bad in "${repos[@]}" Linux Windows macOS X64 ARM64; do
          [ "$tok" = "$bad" ] && fail "\`$r/$f\`: \`$sel\` names \`$bad\`. Selectors should name capability (\`fast\`, \`light\`) only."
        done
      done
    done < <(normalise_runs_on "$body")
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
      done < <(grep -oE "${ORG}/${CONTROL_PLANE}[^@]*@[0-9a-f]{40}" <<<"${body:-}" | grep -oE "[0-9a-f]{40}$" | sort -u || true)
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
    normalise_runs_on "${body:-}" | grep -q "runs-on: \[self-hosted" || continue
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
