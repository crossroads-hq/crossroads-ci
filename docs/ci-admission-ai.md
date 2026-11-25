# HQ-085 Story 7 — dormant shared AI admission

Tracking: [CI #129](https://github.com/crossroads-hq/crossroads-ci/issues/129),
[HQ #298](https://github.com/crossroads-hq/hq/issues/298). Source-only, default OFF.

Current target and admission action source: Story 6 `codex/ci-admission-actions`
at `4772d24aad4c7dde1031541289f331ea33506b2a`,
[PR #132](https://github.com/crossroads-hq/crossroads-ci/pull/132), after the
2026-11-25 startup-hook security repair propagation below. The original target was
`31b0f172dd985ea3fe1c45ee8eb4de35d4f02cc2`; earlier evidence remains historical.
Its GitHub commit verification is `verified:true`, `reason:valid`; both remote
action pins use that exact source, with its existing source hash manifest checked
locally. Story 1 authority remains HQ draft #299 at
`5244cd89b183f069186eb45290019e8059aeb1fb`; latest read-only HQ monitor source
is HQ draft #301 at `d1c5883b1878c47f650a3215b9a0b139ce6863e9`.
Unmerged sources and deterministic fixtures are not runtime acceptance.

## Boundary and composition

The existing `_ai-review.yml` is unchanged, including every input/default,
permission, secret, job name, runner/event assumption, concurrency rule and
remote pin. No existing caller is edited. Current callers continue their
Codex-first, Claude-fallback path. AI remains advisory outside PR Validation;
the native gate, filter authorization, required needs/results and `!cancelled()`
condition remain untouched.

A separate reusable `_ai-review-admission.yml` adds a dormant opt-in entry.
`admission-enabled` is boolean, defaults false, and selects only this source
path; it does not activate or enroll anything. With false both new jobs skip.
A future consumer must deliberately select the new entry at an exact reviewed
SHA, pass true and adopt its additional Checks read grant. This is a new
interface for future enrolled callers, not a changed legacy permission ceiling.
Do not run both AI entries for one consumer. Read-only current-main inspection
confirmed Evolution `.github/workflows/validate.yml` and UI
`.github/workflows/pr-validation.yml` use legacy pin
`68a5403e579bd16e18db67bf53ada022346b3879`, fixed self-hosted Linux X64 fast,
AGENTS.md guidelines and the existing review grants without Checks read.
These observations are discovery evidence, not a claim their branches adopted
this new draft.

The logical workload is fixed **AI**, capability **fast** in the reviewed
future enrollment; neither action accepts a workload/capability/identity input.
The light `admission-ai` job (name `Admission AI`) uses fixed self-hosted Linux
X64 light selectors, a two-minute timeout and only Actions/Checks/Contents/PR
read grants (Metadata read is implicit). It performs one trusted remote root
action, no checkout, install, outputs or heavy dependency. The actual heavy
`review` job (name `AI review`) depends on successful root, uses fixed self-hosted
Linux X64 fast selectors and runs the trusted checkout verifier as its first
step on every actual attempt. Root success is never cached output authority.
Heavy-only retries still verify fresh native attempt/job/root evidence and hold
when their root is omitted. Held/Unknown preflight never invokes the reviewer
or silently falls back to unmanaged review. Before-checkout failure leaves
change/dedup/reviewer outputs unset, so inherited failure reporters cannot
manufacture reviewed success. A failed preflight is not a completed AI review.

Both actions use exact Story 6 pins above. Compiled ENROLLMENTS stays empty;
even true cannot pass the actions or access event files/network/token through
them. No live consumer, scheduler/controller writer, App, install, protection,
secret, runner/group, endpoint, deployment, workflow rerun/cancel or activation
is created. Existing reviewer superseded-head cancellation remains inherited
native behavior, separate from the scheduler's no-preemption contract.

## One editorial owner and unchanged review behavior

`scripts/generate-ai-admission.js` is an editorial tool. Admission/reviewer jobs
never execute it; CI invokes its drift check without reviewer credentials. Regenerate with `node scripts/generate-ai-admission.js`; check with
`node scripts/generate-ai-admission.js --check`. The admitted workflow is a
checked-in generated artifact. Its reviewer steps come from `_ai-review.yml`;
there is no second hand-maintained review policy. CI's existing script test
suite checks generation and parsed structural equivalence on every relevant
change. Any change to the original reviewer must regenerate and review this
artifact in the same draft. Inputs/secrets and every reviewer job field match,
except the explicitly allowlisted admission guard/dependency, Checks read,
fixed runner selection and first preflight. The new entry removes the legacy
`runner-labels` input rather than permitting hosted or unreviewed selectors.

This preserves current-head Codex verification, Unknown-to-Claude fallback,
Claude dedup evidence, base-ref contract/path validation, same-repository fork
and draft/title/actor guards, scoped credentials, review delivery checks and
failure reporting. It preserves all original remote pins. Extraction into a
nested executor was rejected because it would change legacy job naming/depth
and its static workflow tests. Adding Checks read to the old entry was rejected
because skipped jobs still form a static reusable permission contract and
would require existing callers to widen grants.

## Explicit enrollment blocker: heavy job token scope

GitHub grants permissions per job, not per step. The root token is read-only.
The heavy preflight's step-scoped `github.token` also has the reviewer's
**existing** Pull requests write and identity-token write grants. Only Checks
read is added. The verifier's trusted transport makes fixed-origin GETs only;
no scheduler credential enters it and no PR-controlled code runs before it.
This does **not** satisfy a literal read-scoped-heavy-token assertion in the
Story 6/specification contract. Separate-agent architecture review identified
this conflict; source-only delivery records it, without inventing a credential,
weakening review or silently waiving the contract.

**Before enrollment/activation:** owning architecture and human owner must
resolve the heavy-token contract with a reviewed source decision and proof.
This draft supplies no approval for a token exception, new secret or additional
App. Until resolved, do not compile an AI enrollment, enable a consumer, or
claim the AI path is admission-ready. Stories 8–10 must retain this blocker.

## Acceptance mapping and later proof

| Requirement | Deterministic evidence | Remaining owner/native proof |
| --- | --- | --- |
| Existing callers default unchanged | Original workflow unchanged; parsed reviewer/input/secret equality; no caller changes | Actual branch adoption only in later reviewed consumer slices |
| Explicit opt-in OFF | False boolean fixture skips both jobs; no enrollment mutation | Owner setup and explicit activation remain separate |
| No root-heavy deadlock | Root has one step, no needs/outputs; heavy needs successful root | Actual native dispatch and >2-minute light delay drill |
| Fresh first-heavy verification | First unconditional exact-pin action; no cached output/attempt bypass; Story 6 stale/manual-rerun fixtures | Real current attempt/job/native check name prefixes and partial-rerun drills |
| Held/Unknown refuses | Root failure/cancel/skipped/unknown and first-step failure conditions | Exact enrolled App/check/generation/closure proof and native refusal |
| Codex-first/Claude fallback | Equal reviewer steps plus verified/unknown/absent/dedup routing cases | Actual review artifacts and service availability |
| Trusted base/fork/credentials | Equal trusted reviewer body and guards; root read grants, heavy no new write grants | Resolve heavy-token scope conflict before AI enrollment |
| Advisory/gate preservation | Gate unchanged; no AI edge in gate or current caller | Both consumer gate-closure/native App15368 proofs |
| No drift/activation | Generator mutation cases fail comparison; empty ENROLLMENTS, inherited source hashes | Full reviewed recursive local/remote closure, no dynamic/matrix enrollment |

Local validation commands: focused `node --test scripts/ci-admission-ai.test.js
scripts/ci-admission-native.test.js actions/await-codex-review/*.test.js`, full
`node --test scripts/*.test.js`, explicit `bash scripts/validate-local.sh`,
JavaScript/module syntax, workflow parsing, inherited source hash and diff checks.
There is no TypeScript/build toolchain in CI. Local fixture evaluation is a
bounded model of workflow conditions, never native GitHub execution proof.
Required delivery checks, separate independent final-diff review, local SSH
signature/GitHub verification and remote check receipts are recorded on the
draft after completion. No pre-push hook execution is assumed.

## Completed local validation

Initial explicit local push gate passed: **289 tests**, zero failures/skips
(156 script, 92 action, 41 runner-host). Focused AI/native/Codex suite: 107
passed, zero failures/skips. All workflows parsed, new JavaScript syntax and
cached diff checks passed; all nine inherited Story 6 source hashes matched.
The unadapted Mac preflight hit an existing nobody-home fixture expectation
(`/var/empty` versus `/Users/nobody`). The passing full run used process
visibility and the predecessor's inspected temporary PATH-only dscl stand-in
returning unavailable, with no source/system workaround. Docker/pipx are
absent; optional actionlint/zizmor were unavailable. Logs:
`/tmp/ci-ai-preflight-default.log`, `/tmp/ci-ai-preflight.log`,
`/tmp/ci-ai-scripts.log`, `/tmp/ci-ai-focused.log`. No hook execution is claimed.

Separate read-only reviewer `/root/review_story7` (Codex GPT-6 family; exact
backend identifier unavailable, no overrides) independently reviewed the final
staged source diff, ran all 107 focused cases, generation/syntax/parsing/hash
and diff checks with equal before/after source hashes, and found no actionable
correctness/security issue. It required precise disclosure of the heavy-token
blocker; that remains unresolved before enrollment. A wording supplement
clarifies CI executes the editorial drift check while admission/reviewer jobs
do not. Every completed architecture/final/supplement review is posted on the
draft; request and completed service review remain separate.

## Decisions and serial handoff

Existing shared reviewer: **Still valid**, rank 4 existing workflow behavior
and credential/delivery tests; preserve it exactly. Native gate ownership and
empty enrollment: **Still valid**, rank 1 approved HQ-085 specification and
trusted-base AGENTS plus rank 4 native fixtures. New generated opt-in artifact:
small source extension with mechanical drift gate, no live migration. Heavy
token scope: explicit unresolved contract conflict, not acceptance.

Author: in-context Codex, unchanged model/mode. Canonical Portfolio,
Architecture and Engineering principles read at skills revision
`643dfa879cc16b9572d1e7255a6b4e619c2a1579`; no skills copied. Independent
separate agent `/root/review_story7` performs actual final-diff review; author
synthesis is not that review. Every completed review, including no findings,
is posted to the draft.

From CI Engineering/Security to narrow writer owner: after this story's delivery
checks, start Story 8 in its own LOCAL CI chat FROM/TARGET this draft's exact
signed head. Implement only the disabled durable permit/recovery writer,
reservation/write-intent fence before every publication, lost-write reconciliation
and rollback/audit contract. Preserve all inherited safety invariants and this
AI token-scope blocker. Do not enable the writer or provision anything. Then
continue serial one-story/new-chat/draft through Story 10, which stops with the
whole inventory and owner gates. Owner already authorized that continuation;
no merge wait or new split decision is required.

## Remote lint correction recorded before implementation

Initial draft head `b65327b3dbea763b5eb00162bf4ab2d1599d7e6c` exposed a
local coverage gap: Docker/pipx-based optional lint had been unavailable.
Remote run `44875234042`, workflow-lint job `136758395974`, failed because
literal self-hosted `light`/`fast` labels were not declared in this repository's
lint configuration. Existing workflows use expression selectors, which did
not expose this check. Exact actionlint 1.7.12 reproduced both unknown-label
errors locally (`/tmp/ci-ai-actionlint-red.log`). Add only those two existing
fleet label declarations in `.github/actionlint.yaml`, using upstream's
supported self-hosted-runner labels schema, without ignored findings, wildcard
labels, gate changes, runner edits or activation. Preserve the published commit;
deliver the correction as another locally signed commit on this same draft.
Temporary actionlint 1.7.12 and zizmor 1.11.0 macOS binaries were verified
against their official release-asset SHA-256 digests before use; they change
no system installation. Follow-up lint/full-gate/review receipts are posted
after execution.

## Arrived service finding recorded before correction

Codex review `6003486442` at initial head `b65327b3dbea763b5eb00162bf4ab2d1599d7e6c`
reported P2 `discussion_r4651087583`: reviewer-workflow-only changes set the
workflow filter but not the scripts filter, so the new generated-equivalence
test could be skipped. The earlier independent no-findings review did not
catch this coverage defect; it is not a clean service verdict. Add an exact
filter regression, observe failure, then include both reviewer workflow paths
in the existing scripts filter. Keep every gate need/result, skip predicate,
name and `!cancelled()` condition unchanged. No predecessor branch is touched.


Corrected final local evidence: **290 tests passed**, zero failures/skips
(157 scripts, 92 actions, 41 runner-host); **108 focused passed**. Logs:
`/tmp/ci-ai-final-preflight.log`, `/tmp/ci-ai-final-scripts.log`,
`/tmp/ci-ai-final-focused.log`. The existing preflight still reports its
Docker/pipx lint wrappers unavailable; separately executed exact-version
**actionlint 1.7.12 passed** and **zizmor 1.11.0 offline/high passed**.
The latter does not claim online audit coverage. The new filter regression
passed after its recorded red result; generation/syntax/hash/diff checks stay
clean. No required gate logic or existing reviewer is changed. The final
separate-agent correction verdict and GitHub receipts follow on this draft.

## Story 7 reconciliation — 2026-11-24

The owner authorized repairs and forward reconciliation in the existing chats,
with no provisioning or activation. Draft #133 continues to target
`codex/ci-admission-actions`. Adopt exact signed/verified Story 6 head
`0a0ab8dbde95575b7a5e4fae51a738c04e1528cb` forward from Story 7's published
`31c1e265fc0741ddb1de4a550e0a94337d6b1973`, preserving both histories.
The original Story 6 source `31b0f172dd985ea3fe1c45ee8eb4de35d4f02cc2` and
all original test/review receipts above remain historical evidence. They do
not certify this reconciled head.

The fetched Story 6 commit has parents original Story 6 and repaired Story 3
`10b9bb7446f77532c5e0e9759114c63b46b1c0b3`; it contains current main
`6bb5ca4c0af6687cfed409d649b83aec3499da32` through repaired Story 2/3.
Its nine action/runtime/test source hashes are byte-for-byte unchanged and the
original `ci-admission-actions-source.sha256` is retained without relabelling
it as a manifest of unrelated main files. The two admission action pins in the
editorial generator and their regression expectations advance to this exact
Story 6 merge SHA, with the draft #132 provenance comments retained. Regenerate
the admitted workflow from the inherited canonical reviewer, including its
current Claude action pin; never restore an old whole workflow.

Preserve main's default-on queue-wait/gate summary and source pins exactly,
including the inherited, owner-documented read-only Actions grant for that
summary. The Story 7 repair adds no workflow permission. Keep both reviewer
paths in the scripts filter, every required gate need/result, legitimate skip
predicate and exact PR Validation name/`!cancelled()` condition. Default-false
opt-in, fixed root/heavy selectors, fresh first-heavy verification, advisory AI
and empty compiled enrollment remain unchanged. The heavy-token-scope and
other native/activation blockers remain unresolved; no exception or waiver is
introduced here.

Run current full local checks and an independent actual-integration/pin-diff
review before the one combined push. Record the signed new head, current-head
Codex request/results and current CI on draft #133 after they exist; stale
head reviews remain historical. The coordinator sequences propagation to the
prepared Story 8 repair and consumer pin refreshes. This existing chat edits
only Story 7, creates no successor chat and does not touch the waiting Story 8
commit or any consumer branch. The earlier serial handoff instructions above
are superseded by this repair coordination.


Reconciliation local validation: **310 tests passed**, zero failures/skips
(157 scripts, 112 action logic, 41 runner-host). The focused AI/native/Codex/
queue-wait selection passed **128 tests**, zero failures/skips. Exact-pin and
generated-equivalence checks first caught stale source, then passed after the
authoritative pin update and regeneration. All workflow YAML parsed; explicit
JavaScript/module syntax, generation, diff and all nine inherited source-hash
checks passed. Inherited canonical reviewer, gate, queue-wait and other main
workflow definitions match `6bb5ca4c0af6687cfed409d649b83aec3499da32`; the CI
workflow differs only by the retained two reviewer paths in its scripts filter.

Local actionlint 1.7.12 passed; zizmor 1.11.0 offline/high passed with its two
existing suppressions. Their temporary release archives were rechecked against
the original official digests before use. Full preflight used the inspected
PATH-only dscl unavailable fixture and process visibility for the previously
documented Mac account/process fixtures; no source/system workaround or hook
execution is claimed. Docker/pipx wrappers remain unavailable; the separate
exact-version lint runs above supply local lint coverage, not online audits.
Logs: `/tmp/ci-ai-reconcile-{preflight,scripts,focused,actionlint,zizmor}.log`.

Cross-repository upstream pin provenance was checked from each owning repository:
Claude action v1.0.286's annotated tag resolves to `acfe7992852970efb4fee683d63d628e3e52df67`;
dependency-review v5.0.1 resolves to `bbc44d14a204704ccc493733616cd1e93a0321ec`;
create-github-app-token v3.4.0 resolves to `f418cff399f7aef4c2f0ad47e25ca7a6abbdd6fc`.
These are inherited main pin advances, not new selections in this repair.
Story 6's GitHub commit verification is valid and its action source matches the
retained manifest. Native/live proofs and every enrollment/activation blocker
remain outstanding despite deterministic checks.

## Additional Story 3 fix propagation — 2026-11-24

The owner authorized serial forward propagation through the existing #132–#134
chats, with fresh Codex reviews and current CI/security follow-through, without
merging PRs, provisioning or activation. This Story 7 chat owns only #133 and
preserves the owner's existing ready state; it performs no readiness action.
The coordinator releases #134 after verified publication here. No successor
chat, consumer change or other branch write is part of this work.

Forward-merge exact Story 6 `e627853734c095ad2a35d95d47b6089107310ae4` into
published Story 7 `337a4f18e482e686241f6c0d32a7c7e13ea86840`, preserving both
histories. Story 6 has parents its previous `0a0ab8dbde95575b7a5e4fae51a738c04e1528cb`
and authoritative Story 3 `7dae1ecae87f4bfcb57ddc8aab6743342a8c0957`.
The imported fixes check prospective capacity in every retained repository and
accept Git-compatible literal head/base graph refs, with five upstream
regressions. The inherited shadow module/test/docs and source manifest remain
exactly those of the authoritative Story 6 source. No controller policy fork,
action API/protocol/enrollment change or new production integration is added.

Only two manifest entries advance: shadow module
`14384eb9a289057d23ab494429b2420bd770b592a4d5ca4c4e73ddb8ed7c2dec` and
shadow tests `44c442816e4198fb1ffc961ea15cac22a48390ff8fa4d7fa4b02d7e8ef03987b`.
The other seven action/native/policy source entries are unchanged. Earlier
nine-source equality observations and local/review receipts above are
historical, not proof that these two sources stayed unchanged or certification
of the new head. The current inherited manifest is checked in full.

Advance the authoritative generator and regression expectations for both remote
admission actions to exact `e627853734c095ad2a35d95d47b6089107310ae4`, then
regenerate the admitted counterpart. Current main's canonical reviewer,
third-party pins, queue-wait/gate behavior and the Story 7 script-filter
correction remain untouched. Fixed runner selectors, default-false opt-in,
empty compiled enrollment, advisory AI and fresh actual-heavy verification
remain. The known heavy-token scope blocker is not waived or resolved.

Mandatory local gates, scripts tests, changed-area tests, explicit syntax/hash/
generation checks and independent final actual-diff review precede the one
normal Git push. Commit signing/GitHub verification, exact new-head Codex
request and current CI/code/security results are recorded on #133 after they
exist. No settings, App, permission, budget, deployment or CI cancel/rerun
operation is authorized. The coordinator is notified if material predecessor
feedback arrives; publication pauses in that case.


Additional propagation local validation: **315 tests passed**, zero
failures/skips (162 scripts, 112 action logic, 41 runner-host). The focused
AI/shadow/native/canonical/Codex/queue-wait selection passed **181 tests**,
zero failures/skips. Exact-pin expectations first rejected the stale generated
counterpart, then all 11 Story 7 cases passed after authoritative update and
regeneration. All workflow YAML, explicit module/JavaScript syntax, generated
consistency, current nine-source hashes and diff checks passed.

The imported shadow module/test/docs and current source manifest compare
exactly to `e627853734c095ad2a35d95d47b6089107310ae4`. The two changed manifest
entries match the hashes above; the other seven retain their earlier values.
Canonical reviewer/gate/queue-wait source remains exact current main
`6bb5ca4c0af6687cfed409d649b83aec3499da32`. This repair adds no permission,
selector, third-party pin, action protocol or enrollment change.

Exact local actionlint 1.7.12 and zizmor 1.11.0 offline/high passed with two
existing suppressions; temporary archives were checked against their original
official digests. Full preflight used the previously documented inspected
PATH-only dscl-unavailable fixture and process visibility for existing Mac
account/process fixtures, with no source/system workaround. Docker/pipx
wrappers are unavailable; separate exact-version tools supply local lint,
not online audit evidence. No TypeScript/build toolchain or pre-push hook
execution is claimed. Logs: `/tmp/ci-ai-propagate-{preflight,scripts,focused,actionlint,zizmor}.log`.

Independent final actual-diff review, signed merge, current GitHub commit
verification and exact-head CI/code/security receipts follow on #133 after
completion. Earlier successful heads are not substituted for current-head
results. The current owner-set ready state and all owner activation gates
remain unchanged.

## Reviewed startup-hook repair propagation — 2026-11-25

The owner explicitly approved signed local forward merges through #133/#134
once exact-head CI and fresh security pass, using existing chats, with no PR
merge, provisioning or activation. The coordinator exclusively released this
Story 7 chat after independently verifying authoritative #132
`4772d24aad4c7dde1031541289f331ea33506b2a`: current PR Validation, code and
security passed. The source signatures and exact-head receipts were refreshed
here before merging. This ends the earlier source-write hold for this exact
release only; it does not approve any owner activation gate or downstream work.

Forward-merge exact `4772d24aad4c7dde1031541289f331ea33506b2a` into preserved
Story 7 `320283ce0a8220fc32a19cdded49350fe35b60dc`, with no history rewrite.
Its upstream history is e627 → `1246ff6500bd0f36936f8284fd5bbe643dc7ef91`
(security repair) → `4772d24aad4c7dde1031541289f331ea33506b2a`
(portable test-fixture follow-up). The latter changes only the entrypoint test
and its hash/evidence; production guards remain identical to the security fix.
The imported actions, entrypoint tests, current ten-source manifest and action
contract documentation remain byte-exact to this authoritative Story 6 head.

The startup-hook P2 `discussion_r4687002573` is addressed by the owning #132
repair, not waived because enrollment is empty. Both action entrypoints use
only fixed trusted `/usr/bin/node` on Linux, never Bash or caller/runner PATH.
Twenty-eight loader-key presence guards, including empty and legacy cases,
refuse before interpreter launch; Node/shell startup controls are cleared.
Unsafe loader state fails rather than skipping verification. Missing trusted
interpreter or unsupported platform fails closed without fallback. No guard,
interpreter requirement or test is weakened by Story 7 propagation.

The fixed protected host/interpreter integrity and Node 22+ prerequisite still
require later owner setup/native proof. The 18 entrypoint fixtures map the
fixed Linux interpreter to their test process consistently on all hosts; they
prove local runner-contract behavior, not that a real fleet host satisfies the
production path prerequisite or that native action/admission drills passed.
No host install/configuration, runtime activation or live credential is used.

The current source manifest now has **ten entries**: the two action declaration
hashes advance and the entrypoint test source is added; the seven other
existing source entries remain unchanged from e627. Earlier nine-source and
two-shadow-entry observations remain historical. The current ten-source
manifest, canonical shadow fixes and fixed interpreter security boundary are
verified in full on this integration candidate.

Advance both generator-owned admission pins and focused expectations to full
`4772d24aad4c7dde1031541289f331ea33506b2a`, then regenerate the counterpart.
Current main canonical reviewer/third-party pins, default workflow, gates/
needs/results/authorized skips/fork/draft guards, fixed selectors, default OFF,
empty enrollment, advisory AI and heavy-token scope blocker remain unchanged.
No action API/protocol, generic dependency or consumer pin advance is added.

Full local gates, scripts/changed-area/18-entrypoint tests, explicit syntax,
ten hashes and generated consistency plus fresh independent actual-diff/
security-boundary review precede the one normal signed batch push. Every PR
commit is verified on GitHub and a new exact-head Codex review is requested.
The coordinator receives safe-publication evidence promptly but keeps #134
held until this new head's CI, code and security all pass. No successor is
created; this chat owns only #133 and preserves its owner-set ready state.


Security-repair propagation local validation: **333 tests passed**, zero
failures/skips (162 scripts, 130 action logic including all 18 entrypoint
cases, 41 runner-host). The focused AI/shadow/native/canonical/entrypoint/
Codex/queue-wait selection passed **199 tests**, zero failures/skips. All 11
Story 7 exact-pin/generated cases passed after the recorded stale-pin refusal
and regeneration. The imported declarations, entrypoint test, ten-entry
manifest and action documentation compare exactly to the released source.

Explicit YAML and JavaScript/module syntax, all ten current source hashes,
generated consistency and whitespace checks passed. Local actionlint 1.7.12
and zizmor 1.11.0 offline/high passed with two existing suppressions; their
temporary archives were rechecked against official digests. Full preflight
uses the previously documented inspected PATH-only dscl-unavailable fixture
and process visibility for existing Mac account/process cases. No source/
system workaround, host install or pre-push hook execution is claimed.
Docker/pipx wrappers remain unavailable; the separate exact-version lint
checks are local/offline evidence. This repository has no TypeScript/build
toolchain. Logs: `/tmp/ci-ai-security-prop-{preflight,scripts,focused,actionlint,zizmor}.log`.

The original #132 startup-hook thread is resolved with its fix and fresh
4772 CI/code/security receipts. That source result is not substituted for the
new Story 7 head: its own signed commit verification, fresh independent
integration/security-boundary review and exact-head CI/code/security receipts
are recorded on #133 after completion. Fixed-host interpreter/native proofs,
heavy-token scope and all other owner activation gates remain outstanding.
