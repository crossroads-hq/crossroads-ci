# AGENTS.md

Guidance for coding agents working in crossroads-ci, the control plane for the
Crossroads fleet: shared workflows, composite actions, and repository
governance. Both AI reviewers apply the review rules below: Codex reads them
from this file directly, and the Claude fallback receives this file as its
review contract (`guidelines-file: AGENTS.md` in `.github/workflows/ci.yml`),
read from the base branch so a pull request cannot change the rules it is
reviewed under.

## Code Review Rules

### Review contract
- Read the review contract from the trusted base ref, never from the PR checkout. Validate
  caller-controlled paths so they cannot redirect the read to PR-controlled content.
  Otherwise a PR can change the rules used to review itself.

### Shared fleet surfaces
- `_ai-review.yml`, `_supply-chain.yml` and `actions/*` are consumed by fleet repositories.
  Flag changes that break an existing caller: inputs, outputs, secrets, defaults, required
  `permissions`, event assumptions, runner requirements, or nested action pins.
  New configurable behaviour defaults to existing behaviour, unless it corrects a
  documented defect or security issue. Incompatible changes need an explicit migration
  plan naming the affected consumers and the rollout order.

### Merge gate
- On profiles `full` and `full+tags` (`governance/repositories.txt`), `PR Validation` is the
  required check. Flag any rename of it.
- Every mandatory job, and the change-filter job that justifies skips, must be in the
  gate's `needs` and in the results it evaluates. A skip is legitimate only when listed in
  `allow-skipped` and when the filter job's output actually authorizes it; a successful
  filter job alone is not enough.
- Flag `continue-on-error` on required work, and any condition other than intentional
  cancellation handling (the gate's `!cancelled()`) that can skip the gate job. GitHub
  treats a skipped required job as passing.

### Unknown state is not absence
- A malformed or missing response, or one fetched incompletely where pagination is
  required, means state is unknown: fail, or take the safer path (run the Claude fallback).
  Single-page and non-list responses are fine.
- For review evidence, a validated empty result means no review was found and must
  trigger review. Evidence counts only when its provenance matches: expected author
  (id, login and type), repository, workflow, and the current head SHA.

### Running after failure
- A step or dependent job meant to run after a failure needs a condition that actually
  allows it: `failure()`, `!cancelled()`, or `always()` when also running after
  cancellation is intended. `success()`, or no status function (implicitly `success() &&`),
  blocks it. Check the rest of the expression for terms that defeat the purpose.

### Trust boundary
- Keep the `head.repo.full_name == github.repository` fork guard, but do not treat it as
  full trust: same-repository PRs can edit workflows. Flag steps that run PR-controlled
  scripts, local actions, or install hooks while credentials are available.
- Pass untrusted text (PR title, body, branch name, comment) through an intermediate
  `env:` variable, never `${{ }}`-interpolated into `run:` script text.
- Credentials may reach trusted commands through scoped `env:`. Flag logging them,
  interpolating them into script text, or exposing more than a boolean in presence checks.

### Pins
- Third-party actions and cross-repository `uses:` pin a full commit SHA. Keep a comment
  naming the release, or the commit's provenance where no release exists. Flag tags,
  branches and `@main`. A version comment alone does not prove the SHA belongs to the
  intended upstream, so check the source when a pin changes.
