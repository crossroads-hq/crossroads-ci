#!/usr/bin/env bash
#
# Preflight the same checks the CI "Scripts and profiles" job runs, plus optional
# workflow lint when actionlint and/or zizmor are installed locally. Run from
# the repository root before pushing:
#
#   scripts/validate-local.sh
#
# Required tools: bash, shellcheck, jq, ruby (with psych/yaml), node.
# Optional tools: docker (actionlint image), pipx + zizmor.

set -euo pipefail

cd "$(dirname "$0")/.."

require() {
  command -v "$1" >/dev/null || {
    echo "$1 is required but not installed" >&2
    exit 1
  }
}

require bash
require shellcheck
require jq
require ruby
require node

echo "Shell syntax"
n=0
for f in scripts/*.sh; do bash -n "$f"; n=$((n + 1)); done
echo "  bash -n clean on ${n} scripts"

echo "shellcheck"
shellcheck scripts/*.sh
echo "  shellcheck clean"

echo "Governance profiles parse and render"
for f in governance/*.json; do jq empty "$f"; done
while read -r repo profile branch _; do
  case "$repo" in ''|'#'*) continue ;; esac
  case "$profile" in
    full|full+tags) pf=governance/ruleset-full.json ;;
    minimal)        pf=governance/ruleset-minimal.json ;;
    *) echo "unknown profile '$profile' for $repo" >&2; exit 1 ;;
  esac
  jq --arg name "Crossroads ${branch} protection" \
     --arg ref "refs/heads/${branch}" \
     '.name = $name | .conditions.ref_name.include = [$ref]' \
     "$pf" | jq empty
done < governance/repositories.txt
echo "  all fleet entries render"

echo "Composite actions parse"
ruby -ryaml -e 'ARGV.each { |f| YAML.safe_load(File.read(f)) }' actions/*/action.yml
node --check actions/*/*.js
echo "  action.yml files parse; action scripts parse"

echo "Gate logic tests"
node --test actions/gate/check.test.js
echo "  gate logic passes"

if command -v docker >/dev/null; then
  echo "actionlint (docker)"
  docker run --rm -v "${PWD}:/repo" --workdir /repo \
    rhysd/actionlint:1.7.12 -color
  echo "  actionlint clean"
else
  echo "actionlint: skipped (docker not installed)"
fi

if command -v pipx >/dev/null; then
  echo "zizmor (pipx)"
  pipx run zizmor==1.11.0 --min-severity=high .github/workflows/
  echo "  zizmor clean"
else
  echo "zizmor: skipped (pipx not installed)"
fi

echo
echo "validate-local: all required checks passed"
