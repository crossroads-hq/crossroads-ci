# HQ-085 Story 6 — trusted admission verification

Tracking: [CI #129](https://github.com/crossroads-hq/crossroads-ci/issues/129),
[HQ #298](https://github.com/crossroads-hq/hq/issues/298). Source-only, disabled.

The original delivery evidence below belongs to the 2026-11-21 source. The
[additional Story 3 propagation](#additional-story-3-propagation--2026-11-24)
records that propagation. The startup-hook security repair below records the
current action boundary. The first 2026-11-24 reconciliation and earlier
heads, review receipts, source-equality observations and test counts are historical.

## Inherited findings recorded before correction

At Story 3 `94ffb9fcd90b7dd6a03e48815223aa80f13755b2`, service review
6002854035 reported four P2 defects. This successor fixes them without changing
the predecessor branch:

- `discussion_r4650559888`: complete binding can discard an observed heavy ID
  when execution declares null, allowing substitution and an invalid launch.
- `discussion_r4650559889`: null ledger ID matches an unbound heavy ID and can
  turn missing actual identity into known zero accounting.
- `discussion_r4650559894`: queue replacement can transfer a prior run's scoped
  owner request to another native run with identical immutable inputs.
- `discussion_r4650559896`: permit publication validates capacity shape but
  discards retained-reservation feasibility after occupancy/capacity changes.

Each correction requires an exact SQLite regression and independent review
before the action integration. No finding is waived or declared resolved on
the predecessor PR by this document.

Candidate-source correction recorded before implementation: native actual-job
re-fetch used JSON serialization equality, so reordered object properties could
hold otherwise identical native evidence. Compare the explicit authoritative
job fields instead, with a red-then-green property-order regression. Closure
paths also need safe `.github/` local action support rather than only the entry
workflow exception; reject traversal while allowing reviewed nested files.
The same review pass identified that two current phase records could share a
generation while disagreeing on launch clock or root ID. Add cross-phase
consistency regressions before tightening the owning native decoder.

## Exact source dependencies and boundary

Stack FROM/TARGET `codex/ci-admission-shadow` at
`94ffb9fcd90b7dd6a03e48815223aa80f13755b2` (CI draft #131). The predecessor
remains unchanged. Authority is HQ draft [#299](https://github.com/crossroads-hq/hq/pull/299)
at `5244cd89b183f069186eb45290019e8059aeb1fb`, its
[specification](https://github.com/crossroads-hq/hq/blob/5244cd89b183f069186eb45290019e8059aeb1fb/docs/plans/HQ-085-specification.md),
[sources](https://github.com/crossroads-hq/hq/blob/5244cd89b183f069186eb45290019e8059aeb1fb/docs/evidence/hq-085/SOURCES.md)
and [inactive runbook](https://github.com/crossroads-hq/hq/blob/5244cd89b183f069186eb45290019e8059aeb1fb/docs/runbooks/ci-admission-pilot.md).
HQ Story 4 draft #300 at `97745adada6f8419d366c4b03f260a28246c28a3` and
Story 5 draft [#301](https://github.com/crossroads-hq/hq/pull/301) at
`d1c5883b1878c47f650a3215b9a0b139ce6863e9` are cross-repository source
dependencies, without CI ancestry or runtime acceptance. Their fixed private
fleet reader/monitor remain unbound; Hub is read-only, admissionReady false,
and billing Unknown without native per-actual-job closure.

This slice adds two trusted remote composite actions, `actions/admission-root`
and `actions/admission-checkout`, sharing `actions/admission/{verify,read}.mjs`
and `scripts/lib/ci-admission-native.mjs`. Every identity and permit predicate
comes from canonical `scripts/lib/ci-admission.mjs`; no parallel key or policy
implementation is introduced. The existing shadow object remains DISABLED_SHADOW
with effects empty and owns both repositories. No consumer workflow, current
gate, deployment, Worker entry point, binding, poller or writer is added.

**The shipped compiled ENROLLMENTS list is empty.** Both actions fail with the
fixed `Admission held` before event-file/network/token access. There is no
enable input, environment activation switch or consumer-supplied enrollment.
Synthetic test enrollment is dependency injection into local functions only.
Future reviewed source enrollment must supply real numeric App/repository/
workflow identities, the reviewed closure and exact native job mapping after
owner setup; replacing that list does not itself authorize activation.

## Action and wire contracts

The light root is a self-hosted light job, no checkout/install, two-minute job
timeout. Its remote action reads a launch permit bound to its actual native
run/attempt/root and generation, with heavyJobId null. It never waits for a
dependent heavy identity. A root success provides no reusable authority output.

The heavy verification action must be the **first step before checkout** in
every heavy job, including every manual rerun. It reads fresh GitHub evidence
for its actual attempt/job; cached successful root output cannot authorize it.
Current-attempt root must be present and successful, so an omitted old root in
a heavy-only retry holds. Original successful siblings retain their original
actual jobs; this action never renumbers them or releases reservations.

Both actions have no inputs, outputs or nested `uses:`. They invoke only the
trusted shipped Node module via GITHUB_ACTION_PATH, with the workflow's
`github.token` scoped to the verification step. The later startup repair below
replaces the original Bash/PATH launch boundary with a fixed Linux interpreter
and pre-execution loader rejection. Future callers must grant only
Actions/Checks/Contents/Pull requests read and retain Metadata read, use trusted
full-SHA remote actions, and execute no PR-controlled step/action/install hook
before verification. Existing fleet Node (22+) is required; no setup installer
is run under the token. The scheduler App credential never enters a workflow.

Trusted enrollment has repoId, current repository name (cross-checked by numeric
resolution), workflowId/path, digest, schedulerAppId, fixed workload/capability,
root/heavy logical keys and reviewed static native names, and a bounded list of
closure file paths/SHA-256 values. Names only select within a completely read,
reviewed static job graph; they do not prove native job identity. The reader
re-fetches the actual job ID, attempt, runner, check URL and Actions App15368
check with its exact run/job details URL. Dynamic/matrix/unreviewed job names
are not enrolled by this version.

`digest` is SHA-256 of JSON pairs `[path,sha256]` sorted by English path order.
Each local closure file is fetched through the Contents API at the original
workflow/test-merge SHA and hashed in memory. The reviewed entry file binds all
remote immutable pins; review must verify each remote/nested pin's full upstream
provenance and recursively inventory local execution dependencies. A digest is
not a parser that discovers omitted closure files. No source is executed or
retained. Changed workflow/action bytes hold.

The scheduler check name is `CI admission launch / WORKLOAD` or
`CI admission checkout / WORKLOAD`. `output.text` is bounded JSON with
`protocol: hq-085-permit-v1` plus the canonical permit fields: persisted numeric
id/appId, input/execution, phase/status/conclusion, launchIssuedAt/issuedAt/
expiresAt. `external_id` is `hq-085/v1/GENERATION/PHASE`. The authenticated App
payload must self-match the actual GitHub check ID/status/conclusion and all
native current identities. The check ID/generation originate in the future
writer's durable record, never a caller-supplied expected value. Story 8 must
persist/fence/reconcile that record before publication; self-description alone
does not implement persistence. Scheduler checks attach to the test-merge SHA;
native Actions run/job checks retain their native head SHA. No scheduler check
is named PR Validation.

All permit-named checks are decoded before scoping by actual run/attempt/phase.
Wrong App, malformed historical evidence, duplicate IDs, duplicate current
phase or conflicting generation refuses. Valid older runs/attempts remain
history and cannot authorize this job. One current exact candidate invokes the
canonical permitDecision with its authenticated numeric check/App and native
execution binding. Missing evidence never turns into permission.

## Native reads, timing and failure behavior

The dormant adapter requests fixed api.github.com GET endpoints only: numeric
repository resolution; exact native run and attempt; current PR/base/test-merge
refs; original-SHA closure files; fully paged attempt jobs; exact actual job and
native check; fully paged test-merge checks with **filter=all**. Native run PR
metadata and the original runner event must match current refs. Mutable anchors
and numeric repository resolution are re-fetched at the end. Both original
and current same-repository/open/non-draft scopes are required. No arbitrary
upstream URL, direct machine endpoint, credential proxy or write operation.

Pages must have an exact stable total, full expected page length, unique IDs,
and matching next-page presence. Coverage above 1,000 records or 10 pages holds;
it is not labelled complete. Responses are bounded to 1 MiB and 5 seconds per
request within the overall deadline; redirects/errors/non-JSON refuse without
reflecting upstream text. Cache bypass is explicit. API request cost/headroom
and live list consistency under races remain later measured gates.

Read-start/read-completion clocks remain local observation windows, never
upstream source-change time. Evidence must be complete and no older than the
canonical 60 seconds; clock rollback/future windows hold. Each poll reacquires
all evidence. At most six observations, five-second spacing and a 30-second
absolute deadline include read time. Only known absence or a well-formed pending
permit polls again. Invalid/unknown data fails with fixed Admission held.

Launch expires exactly two minutes after issue. Checkout publication must be
strictly before launch expiry, then checkout lasts two minutes from publication.
The canonical predicate permits a still-live checkout after the launch deadline,
but no late publication or renewal. A delayed light job (>2 minutes) holds.
Verification is one read-side predicate, not a durable consume/write or physical
dispatch guarantee. Reservations, expiry/latches and late/old-job obligations
remain with the controller; no timer, timeout or successful action frees them.

## Acceptance mapping and validation

| Requirement | Executed evidence | Remaining proof |
| --- | --- | --- |
| Four inherited P2s | Four red-then-green SQLite regressions; all shadow tests | Final independent review and future runtime binding |
| Root without heavy | Native-format launch fixture | Real dispatch timing after owner-authorized setup |
| Fresh heavy/manual rerun | Exact attempt/job/root checks; cached-output/heavy-only refusal | Native partial Verify/Storybook/gate drill |
| Numeric provenance and immutable inputs | Wrong App/check/job/repo/workflow, changed refs/digest, duplicate generation faults | Real enrolled IDs and full reviewed native closure |
| Missing/incomplete evidence | Malformed/non-list/partial/stale/future/short/duplicate/count-change/over-bound page fixtures | Measured live rate/load/list consistency |
| Phase timing | Expired launch, late publication and absolute poll deadline fixtures | Native light delay/phase-offset drills |
| Trust and disabled default | CLI fixed-text failure even with enable-like environment; no inputs/outputs/checkout/hooks | Consumer full-SHA adoption in Stories 9/10 |
| Reader composition | Fixed-origin GET, native-format end-to-end fixture, concurrent ref-change refusal | Native APIs and runner/check attribution drills |
| No activation | Empty compiled enrollment; unchanged workflow/config/gate | Separate owner protection/App/infra/activation gates |

Run `node --test scripts/ci-admission-{shadow,native}.test.js`,
`node --test scripts/*.test.js`, `bash scripts/validate-local.sh`, explicit
`node --check` for each new .mjs module, and `git diff --check`. There is no
TypeScript/build toolchain. The local preflight omits the script suite and .mjs
syntax loop; this story runs both explicitly. Optional Docker actionlint and
pipx zizmor availability is reported separately. Required checks run explicitly
before each push; no hook execution is assumed.

Final source validation: **279 tests passed, zero failures/skips** (146 fleet
scripts including 38 native and 33 shadow cases; 92 action logic; 41 runner-host).
Full explicit preflight passed shell syntax/shellcheck, profiles/composite
parsing and all existing action/runner tests. Every new .mjs passed explicit
syntax validation; diff checks passed. Unadapted restricted-process preflight
failed the existing `tmp-clean.test.js` live-Postgres process-visibility case.
The final full run used process visibility and the predecessor's temporary
PATH-only dscl stand-in reporting unavailable (the Mac nobody home fixture),
without source/system changes. Docker/pipx are absent; optional actionlint and
zizmor were unavailable. Logs: `/tmp/ci-actions-final-preflight.log` and
`/tmp/ci-actions-final-scripts.log`. No pre-push hook execution is claimed.

Separate read-only reviewer `/root/review_story6` (Codex GPT-6 family; exact
backend identifier unavailable, no overrides) reviewed the inherited corrections
before action integration, then the complete action candidate and corrected
final source/doc diff. Final independent run: **71 focused passed**, zero
failed/skipped, with equal before/after source hashes. No remaining actionable
findings. The overlapping intermediate red-phase run reported the author's two
in-progress regressions accurately; both were corrected before the final verdict.
Each completed review receipt, including no findings, is posted to the draft.
These local checks do not claim native drills, live deployment or activation.

## Provenance, architecture and handoff

`ci-admission-actions-source.sha256` binds the delivered runtime/contracts/tests
by file content. The draft delivery receipt supplies the locally signed,
GitHub-verified commit SHA. Stories 7–10 must use that full 40-character commit
in `crossroads-hq/crossroads-ci/actions/admission-root@SHA` and
`.../actions/admission-checkout@SHA`, with a comment identifying HQ-085 Story 6
and its draft. Do not use a branch, tag, invented release or placeholder in an
executable workflow. This repository adds no consumer `uses:` and no third-party
pin. Later pin advances must retain exact provenance and re-review the closure.

Existing canonical contracts/one object/both repos: **Still valid**, rank 1
approved HQ-085 source decision plus rank 4 contract tests. Improve the four
defective implementations at their owner; keep identity/policy canonical.
Shared action trust and current gate/defaults: **Still valid**, trusted-base
AGENTS and rank 4 existing action tests; preserve every consumer unchanged.
Preflight coverage: **Valid but improvable**, rank 4 CI comparison; explicitly
run omitted checks here. Alternative rejected: consumer-provided enrollment
or local checkout script under tokens, which would cross the trust boundary.
Alternative rejected: waiting on a heavy ID in the root, which would deadlock
the native dependency graph. No wider architectural change is introduced.

In-context author: Codex, unchanged model/mode. Requested canonical Portfolio,
Architecture and Engineering principles read at skills revision
643dfa879cc16b9572d1e7255a6b4e619c2a1579; no skills copied. Independent actual
diff review is a separate agent's work, posted on the draft including every
completed candidate/no-findings review; author synthesis is not that review.

From: CI Engineering/Security, in-context author. To: Shared AI owner and
independent verifier. Work item: Story 7, opt-in advisory AI integration,
default OFF for every existing caller. Decision/request: continue in its own
local CI chat, FROM/TARGET this Story 6 exact delivered head, without merge wait.
Evidence: exact source stack above, source manifest, local gates, posted reviews
and signed draft receipt. Findings/confidence: deterministic disabled source
only; no native/live acceptance. Risks: native event/job/check semantics,
conservative capacity, full closure completeness, API headroom and cross-date
billing remain unproved. Dependencies: Stories 1–6 exact heads and existing
AI reusable workflow/advisory behavior. Requested action: implement Story 7
only, one signed draft and independent/Codex reviews, then serially dispatch
Story 8. Acceptance: opt-in defaults preserve all callers, exact trusted action
pins, no activation; local checks/signatures/review/clean handoff. Open questions:
owner setup, source binding of PR Validation to App15368 on only two consumers,
scheduler App IDs/installations, two-sided private binding allowlists,
physical/unmanaged occupancy, cross-date allocation, separately bounded native
drills, owner acceptance/merge/adoption/deploy and explicit activation remain
gates. Review date: 2026-11-21. No new standalone issue (prior write rejected);
acceptance uses existing CI #129/HQ #298.

## Story 6 reconciliation — 2026-11-24

This first reconciliation was published at
`0a0ab8dbde95575b7a5e4fae51a738c04e1528cb`. Its source-equality observations
describe that head; the additional propagation below supersedes the two shadow
source hashes while preserving the other seven manifest entries.

The owner authorized repairs and forward reconciliation in the existing chats,
without provisioning or activation. Draft #132 still targets
`codex/ci-admission-shadow`. Merge exact Story 3 head
`10b9bb7446f77532c5e0e9759114c63b46b1c0b3` forward into Story 6's original
`31b0f172dd985ea3fe1c45ee8eb4de35d4f02cc2`, preserving both histories. Story 3
now includes Story 2 `07183845f62d7f39dbe6bf28288215d827314c26`, which includes
main `6bb5ca4c0af6687cfed409d649b83aec3499da32`. Their fetched heads matched
the live draft identities; every commit listed in drafts #130 and #131 was
GitHub-verified before adoption.

At this first reconciliation, Story 3 owned the four controller corrections and
their exact regressions. Its controller module and test file were byte-for-byte
identical to the copies already delivered in Story 6. The forward merge needed
no conflict resolution or duplicate patch. Story 6's action modules, canonical
contracts, native fixtures and both action declarations were unchanged. All nine
manifest entries matched at `0a0ab8d`; that historical observation covered those
files, not unrelated main files or documentation. The current manifest records
the later inherited shadow changes described below.

The merge retains main's queue-wait action, its default-on gate summary, its
tests and the action-pin advances exactly as present in Story 3. They are
inherited main changes, not a new Story 6 feature or new pin selection. The
required gate, original needs/results and authorized skips are preserved.
Main's documented read-only Actions grant for the informational queue summary
is retained exactly; this reconciliation adds no permissions beyond those
adopted definitions.
Empty admission enrollment, fixed Admission held failure, trusted no-checkout
root and fresh before-checkout verification remain unchanged. No dormant guard
is enabled and no native proof or activation blocker is waived.

Current local verification, independent actual-merge-diff review, the new signed
head and exact-head Codex request/results are recorded on draft #132 after they
exist. Original 279-test and review receipts above do not certify the new head.
The coordinator owns propagation to the existing Story 7/8 and consumer chats;
this reconciliation creates no successor chat and edits only Story 6's branch.

## Additional Story 3 propagation — 2026-11-24

The owner requested serial propagation through the existing PR stack and fresh
exact-head CI, code and security review. PR #132 was originally opened as a
draft and has since been marked ready by the human owner. Preserve its current
`isDraft: false`; this source update makes no readiness, settings or activation
change. The coordinating repair chat owns subsequent #133/#134 handoffs.

Merge authoritative Story 3 head
`7dae1ecae87f4bfcb57ddc8aab6743342a8c0957` forward into Story 6 head
`0a0ab8dbde95575b7a5e4fae51a738c04e1528cb`, retaining both histories and
the target `codex/ci-admission-shadow`. The inherited change touches only the
shadow controller, its tests and Story 3 documentation: candidate admission
checks the candidate and every retained repository before adding a reservation;
graph head/base refs use a Git-compatible literal branch validator while command
and policy tags retain their strict validator. The five inherited regressions
cover both split-group orders, the unused-repository control, valid literal refs
and malformed refs. No native/action/policy/workflow code is changed here.

The source manifest advances **two entries** to the inherited files:

- Shadow module: `14384eb9a289057d23ab494429b2420bd770b592a4d5ca4c4e73ddb8ed7c2dec`.
- Shadow tests: `44c442816e4198fb1ffc961ea15cac22a48390ff8fa4d7fa4b02d7e8ef03987b`.

The other seven entries remain byte-identical to `0a0ab8d`: canonical contracts,
native decoder/tests, read/verify modules and root/checkout declarations. The
previous all-nine equality claim is historical, not a current assertion. Empty
enrollment and dormant native protocol remain intact; the branch-ref change is
confined to the shadow graph. Main's adopted queue-wait, gate and pins are retained.

Current validation, independent actual-diff review, the new locally signed head,
all-commit GitHub verification and fresh exact-head Codex/CI/security receipts
belong in the PR conversation after they exist. Earlier receipts do not certify
the new head. No successor is dispatched here. Native proofs, cross-date billing,
owner setup, acceptance/adoption and activation gates remain unwaived.

## Startup-hook security repair — 2026-11-25

Security review of `e627853734c095ad2a35d95d47b6089107310ae4` reported
[P2 startup-hook exposure](https://github.com/crossroads-hq/crossroads-ci/pull/132#discussion_r4687002573).
A synthetic-only reproduction confirmed that inherited NODE_OPTIONS ran before
both verifier entrypoints and observed the synthetic GH_TOKEN before Admission
held. Empty enrollment does not waive this invoked-action defect. The coordinator
authorized a narrow entrypoint repair while downstream source updates were held.
Earlier clean security receipts are historical and do not resolve this finding.

The owner directed the bounded repair on 2026-11-25: a fixed trusted interpreter,
poisoned GITHUB_PATH coverage, loader refusal before launch and fresh independent
security review. Bare `node` is insufficient: the runner's managed prepend list
can be modified by an earlier caller step. Both declarations now choose only
`/usr/bin/node -- "{0}"` on Linux. That absolute path bypasses caller PATH and
runner GITHUB_PATH/PrependPath lookup. Trusted host integrity and an operator-owned
Node 22+ at that fixed path are prerequisites; no installation is performed.
Missing interpreter or unsupported host fails closed before verification.

Caller loader controls are rejected by **presence**, including empty or `0`
values, before any child process starts. Individual `toJSON(env.KEY) == 'null'`
checks distinguish absent keys without serializing the token-bearing environment.
The denied set covers Linux preload/audit/search/debug/trace/profile controls,
GLIBC_TUNABLES, Darwin insertion/search/print/closure controls and OpenSSL config/
engine/module controls. In particular LD_TRACE_LOADED_OBJECTS and DYLD_PRINT_ENV
must not be set to empty as a purported fix. Unsafe presence selects the fixed
invalid `/usr/bin/node Admission-held` template, with no script placeholder:
the runner fails the step before process creation. It never skips verification
or treats a bypassed process as success.

NODE_OPTIONS/NODE_PATH and shell startup hooks are statically empty in the step
environment before execution. No Bash is launched. Additional Node startup,
debug/certificate/proxy controls are reset before the fixed interpreter starts.
Literal JavaScript imports only the shipped verifier, calls the fixed phase,
and maps held/error outcomes to fixed Admission held failure. The token remains
step-scoped and is neither interpolated into source nor passed on a command line.
Enrollment, canonical identities, permits, native decoder/read/verify modules,
workflows, gate, model and capabilities are unchanged by this security repair.

The boundary follows the runner's
[ScriptHandler](https://github.com/actions/runner/blob/aea9aaa3a0b49933412c6f59d7f05be037207a28/src/Runner.Worker/Handlers/ScriptHandler.cs)
and [WhichUtil](https://github.com/actions/runner/blob/aea9aaa3a0b49933412c6f59d7f05be037207a28/src/Runner.Sdk/Util/WhichUtil.cs):
absolute interpreter resolution and required-placeholder validation precede
ExecuteAsync. The known loader-key set is explicit; this is not a claim to
recover an already compromised host or sanitize the runner process itself.
Protected host/runtime setup and later native drill proofs remain required.

Independent candidate security review found a missing legacy loader control:
glibc 2.35 treats LD_TRACE_PRELINKING presence as trace mode before the program
starts, including an empty value. Node 22+ does not establish a newer glibc.
Record this defect before correction: both declarations and the four-value
presence regression set must include LD_TRACE_PRELINKING; no host-version waiver.
The correction now adds that guard to both declarations and the explicit
four-value regressions. The
[glibc 2.35 implementation](https://github.com/bminor/glibc/blob/release/2.35/master/elf/rtld.c#L2687)
owns this compatibility evidence; the tests remain local runner-contract fixtures.

`actions/admission/entrypoint.test.js` executes both literal declarations with
synthetic credentials only. It covers Node preload, Bash hooks/functions, fake
step PATH and poisoned runner prepend, plus a bare-interpreter positive attack
control. Every denied loader key is tested with empty, `0`, `1` and a path;
these cases reject before the fixture starts a process. Clean disabled refusal,
fixed-phase verified/held/error wiring and a script path with spaces are covered.
Linux tests use `/usr/bin/node`; macOS maps the fixed Linux executable to its
test process's Node only within the explicit runner-contract fixture. This
does not claim actual GitHub action execution or native admission acceptance.

The manifest advances the two action declarations and adds this new security
test source. Its other seven existing entries remain identical to `e6278537`.
Earlier nine-source equality observations remain historical. Final validation,
independent security/code review, signatures and fresh exact-head service/CI
receipts are recorded on the PR after they exist. No readiness transition,
branch/PR merge, permission/settings change, provisioning or activation occurs.
