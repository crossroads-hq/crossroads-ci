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
| `governance/ruleset-merge-queue.json` | A merge queue on the default branch: the one **repo-level** ruleset the fleet allows, on the repositories in `governance/merge-queue-repositories.txt` — see [Merge queue](#merge-queue). Added on top of the tier ruleset, not instead of it. |
| `scripts/apply-fleet.sh` | Apply every profile. **Dry-run by default**; `APPLY=1` mutates. |
| `scripts/verify-pins.sh` | Report which control-plane version each fleet repository pins, and what bumping would bring. Exit 1 on anything **uncheckable** — a pin naming a commit this repo lacks, a repository whose workflows could not be read, or a gate-requiring profile with no workflows. `STRICT=1` also fails on anything **not current** — behind, unpinned, or diverged from the base — or still addressing the pre-migration owner, which is counted separately so one pin cannot land in both totals. |
| `scripts/verify-org-rulesets.sh` | Prove the **org** rulesets still match the checked-in profiles: rules, parameters, enforcement, bypass, and what each targets. Exit 1 on drift or on anything uncheckable. Compares substance, not `name`/`conditions` — those differ from the profiles by migration, not drift. |
| `scripts/audit-fleet-drift.sh` | Report what escapes org governance: unclassified or unlisted repositories, repo-level rulesets, merge settings, shadowed secrets, identity runner selectors, abandoned control-plane pins. Exit 1 on any MUST FIX. Runs weekly as `.github/workflows/fleet-drift-audit.yml`; see [Fleet drift audit](#fleet-drift-audit). |
| `scripts/clean-branches.sh` | Delete finished remote branches across the roster: closed pull request with an unchanged head, never the default or an open-PR branch. **Dry-run by default**; `APPLY=1` mutates. Runs weekly as `.github/workflows/branch-cleanup.yml`; see [Weekly cleanup](#weekly-cleanup). |
| `scripts/clean-runners.sh` | List, and with `APPLY=1` remove, offline self-hosted runner registrations. Runs weekly as `.github/workflows/runner-cleanup.yml`; see [Weekly cleanup](#weekly-cleanup). |
| `scripts/clean-worktrees.sh` | For a developer machine, not scheduled: find git worktrees whose remote branch is gone or whose branch is merged, and with `APPLY=1` remove them and their branches. Never touches a dirty, locked, detached, current or main worktree. **Dry-run by default**; see [Weekly cleanup](#weekly-cleanup). |
| `scripts/update-stale-prs.sh` | Update open, non-draft, same-repository PRs that have auto-merge enabled and are behind their base. Exit 1 if the PR list may be truncated, a PR's state is unreadable, or an update fails for a reason other than a conflict or race. Runs on every push to main as `.github/workflows/update-stale-prs.yml`; see [Stale PR updates](#stale-pr-updates). |
| `scripts/resolve-conflicts.sh` | Resolve the conflicts on a `needs-rebase` PR with Claude, on demand and locally: merge the base into the head in a scratch worktree, validate, push a signed merge commit. Never force-pushes; never touches forks. See [Resolving conflicts](#resolving-conflicts). |
| `scripts/validate-local.sh` | Preflight CI checks locally before push (~30s; optional actionlint/zizmor). |
| `actions/gate` | The aggregate-gate logic, with `check.test.js` covering it. Composite, not reusable-workflow, so the caller's `PR Validation` check name survives. |
| `actions/detect-reviewable` | The docs-only filter for AI review, with `.github/` and `.claude/` always reviewable. |
| `actions/await-codex-review` | Verifies that the exact official Codex account produced a formal review or structured clean-review comment for the pull request's current head. Abbreviated reviewed-commit markers are resolved to a unique full Git object ID before comparison; stale, ambiguous, pending, dismissed, or spoofed evidence does not suppress the fallback. |
| `actions/update-stale-prs` | Runs `scripts/update-stale-prs.sh` from the pinned commit of this repository. The vehicle for the reusable updater: a caller's token cannot read this private repository, so the script travels inside an action callers may pin. |
| `actions/setup-node-fleet` | Pinned setup-node + npm cache + `npm ci`. |
| `.github/workflows/_supply-chain.yml` | Reusable: dependency review, OSV scan, gitleaks, optional npm audit. |
| `.github/workflows/_ai-review.yml` | Reusable: waits for a current-head Codex automatic review, then runs Claude Sonnet only after the bounded wait or when Codex status cannot be verified. Reads the Claude fallback contract from the **base** ref, so a PR cannot rewrite the rules it is judged by. Keeps the model transcript redacted while surfacing a capped, credential-redacted terminal message for pre-inference API failures. |
| `.github/workflows/_update-stale-prs.yml` | Reusable: mint the PR-updater App token for the calling repository and run `actions/update-stale-prs`, keeping its auto-merge PRs current. See [Stale PR updates](#stale-pr-updates). |
| `.github/workflows/_workflow-lint.yml` | Reusable: actionlint + zizmor over the caller's workflows. |

A Codex thumbs-up reaction never suppresses Claude: reactions carry no head SHA,
and an older review can finish after a newer push and leave its reaction late.
Verified evidence is either a submitted, non-dismissed formal review for the
current head or the exact official Codex bot's structured clean-review comment
whose reviewed-commit marker resolves uniquely to the current head. Other comments and
reaction-only results take the lower-cost Claude Sonnet fallback path.

## Retired: `verify-fleet.sh`

Removed 2026-09-03. It asked "does every repository carry the repo-level
ruleset its profile prescribes?" Under org rulesets targeting the
`fleet-profile` custom property there is no repo-level ruleset to find, so it
answered `DIVERGED` for every repository in the fleet and exited 1 on a
correctly-configured fleet. `scripts/audit-fleet-drift.sh` asks the question
that replaced it: what is ESCAPING inheritance.

Two things this leaves standing, both of which matter more than the script did:

**`scripts/verify-org-rulesets.sh` asks that question at the level it moved
to.** `verify-fleet.sh` compared each repository against a profile; that became
unanswerable under org rulesets, and for a while nobody asked whether the three
org rulesets THEMSELVES still matched `governance/`. Long enough for
`Fleet — minimal protection` to sit at `enforcement: evaluate` while
`governance/ruleset-minimal.json` said `active` — every `minimal` repository
unprotected, every script reporting clean. Found by hand on 2026-09-03; the new
check is what finds it next time, and it found a second drift on its first run.

**`apply-fleet.sh` is the other half of the same retired generation.** It
writes REPO-LEVEL rulesets to every entry in `governance/repositories.txt`.
Running it against the current fleet would recreate, fleet-wide, exactly the
repo-ruleset-shadows-org condition `audit-fleet-drift.sh` reports as MUST FIX.
It is still here because bootstrapping a repository before the org property is
set is a real case, but it is no longer the way the fleet is governed — read
its output before letting `APPLY=1` near it.

## Usage

```sh
scripts/validate-local.sh           # preflight before push
scripts/apply-fleet.sh              # plan (default; mutates nothing)
APPLY=1 scripts/apply-fleet.sh      # apply
scripts/verify-org-rulesets.sh      # org rulesets vs governance/; nonzero on drift
scripts/verify-pins.sh              # which control-plane version each repo runs
scripts/audit-fleet-drift.sh        # what escapes org governance; nonzero on MUST FIX
```

Caller-side, in any fleet repository:

```yaml
jobs:
  supply-chain:
    uses: crossroads-hq/crossroads-ci/.github/workflows/_supply-chain.yml@main
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
    uses: crossroads-hq/crossroads-ci/.github/workflows/_ai-review.yml@<commit-sha>
    # A called workflow's jobs may not exceed the CALLER's grant. The review
    # job needs `pull-requests: write` to comment and `id-token: write` for
    # the Claude App token; `id-token` defaults to none and is never
    # inherited, so omitting this block fails the run at startup.
    permissions:
      contents: read
      pull-requests: write
      actions: read         # head-SHA dedup reads /actions/runs and its jobs
      id-token: write
    # Optional: defaults to 300. This is a delivery wait, not a token-exhaustion
    # detector; GitHub does not expose Codex quota state to this workflow.
    with:
      codex-wait-seconds: 300
    # The company Console key (CI workspace), a crossroads-hq org secret
    # delivered by Infisical (crossroads-fleet / prod / ci). The callee still
    # accepts `claude-code-oauth-token` and prefers the key when both are set,
    # but no fleet caller passes the OAuth token any more; it is being retired.
    secrets:
      anthropic-api-key: ${{ secrets.ANTHROPIC_API_KEY }}

  gate:
    name: PR Validation            # the name IS the contract — never rename
    if: ${{ !cancelled() }}
    needs: [verify, supply-chain]
    runs-on: ubuntu-latest
    # No checkout when pinning the remote action (crossroads-ui pattern).
    # This repo's ci.yml checks out because it calls ./actions/gate locally.
    steps:
      - uses: crossroads-hq/crossroads-ci/actions/gate@main
        with:
          results: |
            { "Verify": "${{ needs.verify.result }}",
              "Supply chain": "${{ needs.supply-chain.result }}" }
```

### Fleet drift audit

`.github/workflows/fleet-drift-audit.yml` runs `scripts/audit-fleet-drift.sh`
every Monday. It reads the fleet as the **crossroads-ci-fleet-audit** GitHub
App, never a personal token (crossroads-os ADR-0005 rule 4). Each run mints a
read-only installation token from two repository secrets:

| Secret | Kind | Source |
| --- | --- | --- |
| `FLEET_AUDIT_APP_CLIENT_ID` | config | The App's Client ID |
| `FLEET_AUDIT_APP_PRIVATE_KEY` | credential | A private key generated on the App, the whole `.pem` |

Both live in Infisical, project `crossroads-ci`, Production, `/ci`, and reach
this repository only through the sync `ci-ci-prod`. Never set them here by
hand. Without them the run stops at its first step and says so. There is
deliberately no `GITHUB_TOKEN` fallback. That token is scoped to this
repository, so it sees only the fleet's public repositories, and the fallback
reported every private one as missing. Every scheduled run from 2026-09-07 to
2026-10-05 failed on those false findings.

The App is owned by `crossroads-hq`, installed on **all repositories** (the
classification check must see a repository nobody listed), with no webhook
and nothing but read access. It holds no Administration permission: REST
returns the merge settings only to a token with Contents write, so the
audit reads them over GraphQL, which returns them to any reader.

| Scope | Permission | For |
|---|---|---|
| Repository | Metadata | listing the org's repositories, private ones included; repository rulesets; merge settings, read over GraphQL |
| Repository | Contents | workflow files and pin comparisons |
| Repository | Secrets | repository secret names, for the shadowing check |
| Organization | Custom properties | reading `fleet-profile` |
| Organization | Secrets | org secret names, for the shadowing check |

To rotate the key: generate a new one on the App and keep the old one active,
replace the value in Infisical, let `ci-ci-prod` sync, run the audit by hand
(Actions, Fleet drift audit, Run workflow) and check it audits every
repository, then delete the old key on GitHub and the downloaded file.

Run by hand with an owner token, the script needs no secret:
`scripts/audit-fleet-drift.sh`. A classic `gh` login without `admin:org`
cannot read org secrets, so that one check reports as skipped.

This repository is private; fleet repositories can use its actions and
workflows because Actions access is set to `user` scope
(`gh api repos/crossroads-hq/crossroads-ci/actions/permissions/access`).

### Weekly cleanup

Three jobs keep the fleet tidy. All are dry-run until switched on, and none of
them depends on the self-hosted fleet being up, except the host timer, which
runs on the hosts themselves.

| Job | Where | When | What |
|---|---|---|---|
| Branch cleanup | `.github/workflows/branch-cleanup.yml`, `scripts/clean-branches.sh` | Sundays 06:00 UTC | Deletes finished remote branches on every repository in `governance/repositories.txt`. |
| Runner registration cleanup | `.github/workflows/runner-cleanup.yml`, `scripts/clean-runners.sh` | Sundays 06:30 UTC | Lists, and when enabled removes, offline self-hosted runner registrations. |
| Runner host cleanup | `runner-host/fleet-runner-clean.sh` and its systemd timer | Sundays 04:00 local, idle only | Old `_work` checkouts and `_temp`, merged local branches in the checkouts, an oversized npm cache, Docker leftovers. See [runner-host/README.md](runner-host/README.md). |

**What counts as a deletable branch.** Not the default branch, the roster's
branch, a protected branch or a `gh-readonly-queue/*` branch; no open pull
request has it as its head; and a closed pull request from the same repository
has the branch's current tip as its head commit. A branch with no pull request
is never deleted, however old, and neither is one with commits pushed after its
pull request closed. A merged-into-default test was left out on purpose: a
branch created today from the tip of `main` is "merged" too. Every deletion
prints the branch's tip, so it can be restored with
`git push origin <sha>:refs/heads/<name>`. An unreadable list is an error, and
more than 50 deletable branches in one repository (`MAX_DELETE`) deletes none
there.

**Switching it on.** A scheduled run only deletes when the repository variable
`BRANCH_CLEANUP_APPLY` is `true`, and only removes runner registrations when
`RUNNER_CLEANUP_APPLY` is `true`. Until then each run lists what it would do in
the job summary. Read one summary, then set the variable. A manual run
(Actions, Run workflow) acts only if its `apply` box is ticked. By hand:
`scripts/clean-branches.sh` is a dry run, `APPLY=1 scripts/clean-branches.sh`
deletes.

**Offline runners are a judgement call.** GitHub reports a runner as offline,
never for how long, and a host that is merely down looks like a retired one;
removing the registration means registering the runner again by hand. GitHub
already removes a runner that has not connected for 14 days. The script never
removes a busy runner, and treats a scope in which every runner is offline as
"the fleet is down" and removes nothing from it. Keep `RUNNER_CLEANUP_APPLY`
unset unless you want that anyway.

**On your own machine.** None of the jobs above touch a developer's clones or
worktrees. `scripts/clean-worktrees.sh ~/code` lists the worktrees under a
folder that are finished with: clean, unlocked, on a branch, and either with a
deleted remote branch (after `git fetch --prune`) or merged into the default
branch with commits of its own. `APPLY=1` removes them with `git worktree
remove` and deletes the branch with `git branch -d`, never `-D`, so a
squash-merged branch keeps its branch and is reported for you to check. It is
run by hand. `runner-host/install-macos.sh` can schedule a weekly **report-only**
run of it, and the weekly runner cleanup, as launchd agents; see
[runner-host/README.md](runner-host/README.md#on-a-mac). It needs only `git` and
runs on macOS's bash 3.2.

**Two GitHub Apps, one secret pair each**, delivered by Infisical like the
others and never set by hand. Neither exists yet; both are created by an
organization owner:

| App | Secrets | Permissions | Installed on |
|---|---|---|---|
| `crossroads-ci-branch-cleaner` | `BRANCH_CLEANER_APP_CLIENT_ID`, `BRANCH_CLEANER_APP_PRIVATE_KEY` | Contents: write, Pull requests: read, Metadata: read | The repositories in `governance/repositories.txt` |
| `crossroads-ci-runner-cleaner` | `RUNNER_CLEANER_APP_CLIENT_ID`, `RUNNER_CLEANER_APP_PRIVATE_KEY` | Administration: write (repository), Self-hosted runners: write (organization), Metadata: read | The same repositories |

They are separate because runner administration is a much larger permission
than deleting a branch. With neither secret of an App set, and its apply
variable (`BRANCH_CLEANUP_APPLY` / `RUNNER_CLEANUP_APPLY`) not `true`, its
workflow skips with a notice in the job summary, so nothing goes red before the
App exists. With only one of the two set, or with neither once the apply variable
is `true` (the App is then expected to exist, and a broken secret sync must not
become weeks of green runs that clean nothing), it fails and names what is
missing. It never falls back to `GITHUB_TOKEN`, which sees only this repository.
The rulesets already forbid deleting `main`, and `v*` tags on `full+tags`
repositories, as a second line of defence.

### Stale PR updates

The rulesets require a branch to be current with `main`, so each merge strands
every other open PR until someone clicks "Update branch", and auto-merge
cannot get past that. `.github/workflows/update-stale-prs.yml` clicks it on
every push to `main`, for PRs that are open, not drafts, from this repository,
and have **auto-merge enabled**. Enable auto-merge (`gh pr merge --auto`) to
opt a PR in. PRs without it are left alone, so a merge does not re-run CI and
AI review on every open PR. A PR that conflicts is left to its author, with a
`needs-rebase` label and one comment per head commit; the label comes off once
the PR is current again.

It authenticates as a GitHub App, not `GITHUB_TOKEN`: a push made with
`GITHUB_TOKEN` starts no workflows, so the updated PR would never re-run
`PR Validation`.

| Secret | Kind | Source |
| --- | --- | --- |
| `PR_UPDATER_APP_CLIENT_ID` | config | The App's Client ID |
| `PR_UPDATER_APP_PRIVATE_KEY` | credential | A private key generated on the App, the whole `.pem` |

App setup (owner action): create a GitHub App owned by `crossroads-hq`, no
webhook, with Repository permissions **Contents: write**, **Pull requests: write**
and **Workflows: write**, installed on this repository. Workflows is needed
because the merge `update-branch` creates carries any `.github/workflows`
change from `main`, and GitHub rejects such a commit from an App without it.
The workflow requests exactly these three, so the token fails to mint until
the App holds all of them. Deliver both secrets through Infisical
like the fleet-audit App's. Without them the run fails at its first step and
says why.

The App's slug, `crossroads-ci-pr-updater`, is also named in `_ai-review.yml`
as the one bot the Claude fallback reviewer accepts (`allowed_bots`). The
action rejects any other bot as a non-human actor, and a re-run keeps the
original actor, so without that entry every updater push would leave its head
without the fallback review. If the App is renamed or recreated under another
slug, change that entry and the test beside it, then bump the `_ai-review.yml`
pin in the consumers.

### Merge queue

The stale-PR updater above is one answer to stranded branches; a merge queue
is the other. GitHub tests each queued PR against the latest `main` (plus the
PRs ahead of it) and merges in order, so a merge no longer strands every open
PR and restarts its CI.

GitHub offers the merge-queue rule only in **repository** rulesets ("This rule
is not available for rulesets created at the organization level", Available
rules for rulesets), so it cannot ride the org rulesets the rest of the fleet
uses. It is the one declared exception to "no repo-level rulesets":

- `governance/ruleset-merge-queue.json` is the profile, holding nothing but the
  `merge_queue` rule. The tier ruleset still requires `PR Validation`, signed
  commits and a pull request on top of it.
- `governance/merge-queue-repositories.txt` lists the repositories that carry
  it. `scripts/audit-fleet-drift.sh` accepts a repo-level ruleset only there,
  only under the profile's name and only while `merge_queue` is its sole rule;
  `scripts/verify-org-rulesets.sh` checks each listed repository carries it and
  that it matches the profile.

Opt-in, not a tier: a queued PR is validated by a `merge_group` event, so a
repository whose `PR Validation` workflow does not run on `merge_group` would
queue PRs that never merge.

**Not available to private repositories on the Team plan.** GitHub offers merge
queues to public repositories owned by an organization and to private ones on
GitHub Enterprise Cloud; `crossroads-hq` is on Team. `crossroads-evolution`
(private) was to be the first, and creating its ruleset failed on 2026-10-11
with 422 "Invalid rule 'merge_queue'", so the list is empty. The profile and
the checks stay, ready for a public repository or a plan change; until then
the [stale-PR updater](#stale-pr-updates) is the answer for private ones.

The parameters are sized for the self-hosted fleet: at most two queue groups
build at once (`max_entries_to_build: 2`), so the queue cannot take every
`fast` runner from ordinary PR validation; a group that has not reported in 60
minutes is dropped, above the slowest measured `Validate`. `merge_method:
MERGE` keeps the merge commits the fleet already uses, which GitHub signs, so
`required_signatures` still holds.

To add a repository: list it in `governance/merge-queue-repositories.txt` in a
pull request, and once that merges create the ruleset (repository admin):

```bash
gh api -X POST repos/crossroads-hq/<repo>/rulesets --input governance/ruleset-merge-queue.json
```

### Resolving conflicts

A PR that `update-stale-prs.yml` labels `needs-rebase` conflicts with `main`.
Resolve it with Claude from a checkout of this repository:

```bash
scripts/resolve-conflicts.sh 123          # PR number
scripts/resolve-conflicts.sh --no-push 123 # stop after validation, to look first
```

It merges `main` into the PR branch in a scratch worktree (a merge commit, not a
rebase: the rulesets require signed commits and the PR's history stays intact),
has Claude resolve the conflicted files, runs `scripts/validate-local.sh`, and
only then pushes the merge commit as a plain fast-forward and removes the label.
If anything fails it pushes nothing, leaves the label on, and keeps the scratch
worktree (path printed). It never force-pushes and refuses fork PRs.

Guardrails, because the PR's content is untrusted:

- Claude gets Read, Edit, Glob and Grep only: no shell, no network, no git, no
  settings or hooks from the PR checkout. The script then checks it edited only
  the conflicted files, created none, left no markers, and changed every one.
- It refuses, and leaves the PR to a human, when the conflict touches
  `.github/`, `governance/` or `AGENTS.md` (the gate and the review contract),
  is a delete/modify conflict, or touches a file that defines validation
  (`scripts/validate-local.sh` here), which could not vouch for itself.
- Validation runs the PR's tests, so it runs in a `bwrap` sandbox (no network,
  no view of your home directory, throwaway `HOME`). `sandbox-exec` on macOS
  cannot exec the setuid `ps` that `runner-host/tmp-clean.test.js` needs, so on
  macOS the script refuses unless `RESOLVE_UNSANDBOXED=1`, which runs the tests
  as you with a scrubbed environment but your credentials readable on disk. Use
  Linux or WSL for the sandboxed path.
- Validation is per repository. Defaults suit this one; set these to use the
  tool in another fleet repository:

  | Variable | Default | Meaning |
  | --- | --- | --- |
  | `RESOLVE_VALIDATE` | `bash scripts/validate-local.sh` | Command run in the merged tree. Sandboxed it has no network and an empty `HOME`, so it must pass offline; with `RESOLVE_UNSANDBOXED=1` it may install first. |
  | `RESOLVE_VALIDATE_FILES` | `scripts/validate-local.sh` | Space-separated paths that define validation (script, `package.json`, a lockfile). A conflict in one, or a PR that changes one, is refused: a change cannot vouch for its own checks. |
  | `RESOLVE_VALIDATE_TOOLS` | `bash shellcheck jq ruby node` | Tools put on the sandbox `PATH`, on top of the system directories. |
  | `RESOLVE_PROTECTED` | `.github/`, `governance/`, `AGENTS.md` | Extended regex of paths Claude must not resolve. |

  For example, a Node repository:
  `RESOLVE_UNSANDBOXED=1 RESOLVE_VALIDATE='npm ci && npm test' RESOLVE_VALIDATE_FILES='package.json package-lock.json' RESOLVE_VALIDATE_TOOLS='bash node npm' scripts/resolve-conflicts.sh 123`,
  run from a checkout of that repository.
- The commit is signed with your key (`git -S`); the key must be registered on
  GitHub as a signing key. The push uses your credentials, so it starts the
  PR's workflows (a `GITHUB_TOKEN` push would not).

**Why not a CI workflow.** A `workflow_dispatch` job with an Anthropic API key
would mean a job holding a write token next to a checkout of the PR head, next
to a model reading PR text. Doing that safely takes three jobs (resolve with no
write token, validate with no credentials and no network, push with the token
and no PR code) plus a way to sign the merge commit with the App, for a task
that happens a few times a month and ends with a human watching the PR anyway.
The local tool keeps the model and the PR's code away from every CI credential.
Revisit if conflicts become frequent enough that waiting for someone at a
keyboard hurts.

#### In other fleet repositories

Add a caller on push to the repository's base branch, pinned to a SHA like the
other reusable workflows:

```yaml
name: Update stale PRs
on:
  push:
    branches: [main]
  workflow_dispatch:
permissions:
  contents: read
jobs:
  update:
    uses: crossroads-hq/crossroads-ci/.github/workflows/_update-stale-prs.yml@<commit-sha>
    secrets:
      app-client-id: ${{ secrets.PR_UPDATER_APP_CLIENT_ID }}
      app-private-key: ${{ secrets.PR_UPDATER_APP_PRIVATE_KEY }}
```

Per repository, that is all, once the owner has done the one-time setup:

- Install the App on the repository, and make the two secrets visible to it.
  Set them at **org level** (selected repositories) rather than per repository;
  `crossroads-ci` itself has them at repository level today.
- The base branch is `main` unless the caller passes `with: { base-branch: ... }`.
  The job refuses to run for any other ref, so a manual run from a feature
  branch cannot use the token.
- It always runs on a GitHub-hosted runner, one short job per merge, and has no
  `runner-labels` input. A private repository pays about a minute per merge.
  That is deliberate: the job holds the App's private key, which can write to
  every repository the App is installed on, so it never runs on the shared
  self-hosted fleet (owner decision, 2026-10-12).
- Only repositories whose profile enforces strict up-to-date branches gain
  anything (`full` and `full+tags` in `governance/repositories.txt`); on
  `minimal` there is nothing to click.

The reusable workflow runs the script from this repository through
`actions/update-stale-prs`, pinned by SHA inside it. After changing
`scripts/update-stale-prs.sh`, bump that pin to a commit on `main`; callers then
pick the new script up by bumping their own pin of the workflow.

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
  fleet behaviour. Narrowing to squash-only was proposed while the control
  plane was being planned (August 2026; that plan was never committed) and
  deliberately not bundled into the drift reconciliation; adopt it, if at all,
  as its own reviewed change.
- `required_approving_review_count` stays 0: a solo owner cannot approve their
  own PR. Recorded with a review date in `repository-protection-policy.yml`.
