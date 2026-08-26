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
| `scripts/validate-local.sh` | Preflight CI checks locally before push (~5s; optional actionlint/zizmor). |
| `actions/gate` | The aggregate-gate logic. Composite, not reusable-workflow, so the caller's `PR Validation` check name survives. |
| `actions/detect-reviewable` | The docs-only filter for AI review, with `.github/` and `.claude/` always reviewable. |
| `actions/setup-node-fleet` | Pinned setup-node + npm cache + `npm ci`. |
| `.github/workflows/_supply-chain.yml` | Reusable: dependency review, OSV scan, gitleaks, optional npm audit. |
| ~~`.github/workflows/_ai-review.yml`~~ | Retired 2026-08-24: the Claude reviewer produced zero reviews across its comparison window; Copilot-on-push (ruleset rule) and the OpenAI diff reviewer carry AI review. |
| `.github/workflows/_workflow-lint.yml` | Reusable: actionlint + zizmor over the caller's workflows. |

## Usage

```sh
scripts/validate-local.sh           # preflight before push
scripts/apply-fleet.sh              # plan (default; mutates nothing)
APPLY=1 scripts/apply-fleet.sh      # apply
scripts/verify-fleet.sh             # drift check; nonzero exit on divergence
```

Caller-side, in any fleet repository:

```yaml
jobs:
  supply-chain:
    uses: tsviser/crossroads-ci/.github/workflows/_supply-chain.yml@main
    with: { npm-audit: true }

  gate:
    name: PR Validation            # the name IS the contract — never rename
    if: ${{ !cancelled() }}
    needs: [verify, supply-chain]
    runs-on: ubuntu-latest
    # No checkout: the composite reads job results only.
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
