# crossroads-ci

The Crossroads fleet's CI control plane. Everything that defines what a
Crossroads repository *is* — its branch protection, its shared workflow
logic, its supply-chain checks — lives here, once, instead of copy-pasted
across the fleet where it drifts.

The prior generation of this tooling lived in `crossroads-agent-system/
governance/` and proved the point: the apply script inlined its payload
instead of reading the checked-in JSON, the live rulesets gained
`require_extra_approval_for_unattributed_changes` while the file did not,
and re-running the script would have silently downgraded the fleet.
Here, the JSON profiles are the only copy.

## Layout

| Path | What it is |
|---|---|
| `governance/repositories.txt` | The reviewed fleet list: repository → profile → branch. |
| `governance/ruleset-full.json` | Protection for repositories with a `PR Validation` gate. |
| `governance/ruleset-minimal.json` | Protection for repositories with no CI — everything except the status check. Exists so "no CI yet" stops meaning "no protection at all". |
| `governance/tag-ruleset.json` | `v*` release tags immutable, for repositories that publish from a tag push. |
| `scripts/apply-fleet.sh` | Apply every profile. **Dry-run by default**; `APPLY=1` mutates. |
| `scripts/verify-fleet.sh` | Prove the fleet still matches the profiles. Exit 1 on drift. |
| `scripts/verify-pins.sh` | Report which control-plane version each fleet repository pins, and what bumping would bring. Exit 1 on anything **uncheckable** — a pin naming a commit this repo lacks, a repository whose workflows could not be read, or a gate-requiring profile with no workflows. `STRICT=1` also fails on anything **not current** — behind, unpinned, or diverged from the base. |
| `scripts/validate-local.sh` | Preflight CI checks locally before push (~5s; optional actionlint/zizmor). |
| `actions/gate` | The aggregate-gate logic, with `check.test.js` covering it. Composite, not reusable-workflow, so the caller's `PR Validation` check name survives. |
| `actions/detect-reviewable` | The docs-only filter for AI review, with `.github/` and `.claude/` always reviewable. |
| `actions/await-codex-review` | Verifies that the official Codex bot submitted a review for the pull request's current head. Stale, pending, dismissed, or spoofed reviews do not suppress the fallback. |
| `actions/setup-node-fleet` | Pinned setup-node + npm cache + `npm ci`. |
| `.github/workflows/_supply-chain.yml` | Reusable: dependency review, OSV scan, gitleaks, optional npm audit. |
| `.github/workflows/_ai-review.yml` | Reusable: waits for a current-head Codex automatic review, then runs Claude only after the bounded wait or when Codex status cannot be verified. Reads the Claude fallback contract from the **base** ref, so a PR cannot rewrite the rules it is judged by. |
| `.github/workflows/_workflow-lint.yml` | Reusable: actionlint + zizmor over the caller's workflows. |

## Usage

```sh
scripts/validate-local.sh           # preflight before push
scripts/apply-fleet.sh              # plan (default; mutates nothing)
APPLY=1 scripts/apply-fleet.sh      # apply
scripts/verify-fleet.sh             # ruleset drift; nonzero exit on divergence
scripts/verify-pins.sh              # which control-plane version each repo runs
```

Caller-side, in any fleet repository:

```yaml
jobs:
  supply-chain:
    uses: tsviser/crossroads-ci/.github/workflows/_supply-chain.yml@main
    with: { npm-audit: true }

  # Enable Codex automatic reviews for the repository in ChatGPT first. This
  # workflow observes the resulting GitHub review; it does not trigger Codex.
  # Requires the caller workflow to fire on `synchronize`, or the reviewers
  # only ever sees a pull request's opening state. GitHub's DEFAULT types are
  # [opened, synchronize, reopened] — synchronize is already there, so a caller
  # with no `types:` needs no change. `ready_for_review` is NOT a default: add
  # the explicit list if a draft being marked ready should trigger a review.
  #   on:
  #     pull_request:
  #       types: [opened, synchronize, reopened, ready_for_review]
  ai-review:
    # Pin a SHA, not @main. The tamper-resistance argument for this workflow
    # rests on a consumer's pull request being unable to move the ref it
    # runs; @main is a ref this repository can move under every consumer.
    uses: tsviser/crossroads-ci/.github/workflows/_ai-review.yml@<commit-sha>
    # A called workflow's jobs may not exceed the CALLER's grant. The review
    # job needs `pull-requests: write` to comment and `id-token: write` for
    # the Claude App token; `id-token` defaults to none and is never
    # inherited, so omitting this block fails the run at startup.
    permissions:
      contents: read
      pull-requests: write
      actions: read         # head-SHA dedup reads /actions/runs and its jobs
      id-token: write
    # Optional: defaults to 600. This is a delivery wait, not a token-exhaustion
    # detector; GitHub does not expose Codex quota state to this workflow.
    with:
      codex-wait-seconds: 600
    secrets:
      claude-code-oauth-token: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}

  gate:
    name: PR Validation            # the name IS the contract — never rename
    if: ${{ !cancelled() }}
    needs: [verify, supply-chain]
    runs-on: ubuntu-latest
    # No checkout when pinning the remote action (crossroads-ui pattern).
    # This repo's ci.yml checks out because it calls ./actions/gate locally.
    steps:
      - uses: tsviser/crossroads-ci/actions/gate@main
        with:
          results: |
            { "Verify": "${{ needs.verify.result }}",
              "Supply chain": "${{ needs.supply-chain.result }}" }
```

This repository is private; fleet repositories can use its actions and
workflows because Actions access is set to `user` scope
(`gh api repos/tsviser/crossroads-ci/actions/permissions/access`).

## Rules that keep this honest

- **The check name `PR Validation` is plain text in every ruleset.** Rename a
  gate job without updating the profile and protection breaks silently.
- **`full` requires a gate to exist.** Applying it to a repository that never
  reports the check blocks every PR permanently — `bypass_actors` is empty and
  administrators are enforced. That is what `minimal` is for.
- **A pull request can rewrite the gate that judges it.** On a `pull_request`
  event the workflow definition comes from the merge ref, so a PR editing
  `ci.yml` changes its own `results` and `needs` and still reports
  `PR Validation` green. Not closable from inside CI. It is why a diff
  touching `.github/` needs human eyes, and why shared logic lives in this
  repository behind a SHA pin, where a consumer's pull request cannot reach
  it — the rules below reduce the blast radius, they do not remove it.
- **Excusing a skip means requiring its filter job.** A job skips when a job
  it `needs` fails, so a path-filter job left out of `results` can fail, skip
  every leg it feeds, and let the gate pass on excused skips alone. List the
  filter job in `results` and keep it out of `allow-skipped`.
- **The secret scan is not path-filtered.** Gating `_supply-chain.yml` on
  changed paths skips gitleaks along with everything else, and a credential
  pasted into a README is the ordinary case. Filter the lockfile legs with the
  workflow's own inputs instead.
- **Changes to `governance/` are governance decisions**, reviewed as such.
  Exceptions are temporary, owned, and carry an expiry — see
  `repository-protection-policy.yml`.

## Open decisions

- `allowed_merge_methods` stays `["merge", "squash", "rebase"]`, matching live
  fleet behaviour. Narrowing to squash-only was proposed in the CI roadmap and
  deliberately not bundled into the drift reconciliation; adopt it, if at all,
  as its own reviewed change.
- `required_approving_review_count` stays 0: a solo owner cannot approve their
  own PR. Recorded with a review date in `repository-protection-policy.yml`.
