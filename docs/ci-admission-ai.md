# HQ-085 Story 7 — dormant shared AI admission

Tracking: [CI #129](https://github.com/crossroads-hq/crossroads-ci/issues/129),
[HQ #298](https://github.com/crossroads-hq/hq/issues/298). Source-only, default OFF.

Stack FROM/TARGET Story 6 `codex/ci-admission-actions` at
`31b0f172dd985ea3fe1c45ee8eb4de35d4f02cc2`, [draft #132](https://github.com/crossroads-hq/crossroads-ci/pull/132).
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

Full explicit local push gate passed: **289 tests**, zero failures/skips
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
