# HQ-085 Story 2 — pure admission contracts

Tracking: [CI #129](https://github.com/crossroads-hq/crossroads-ci/issues/129).
Depends on **HQ draft [#299](https://github.com/crossroads-hq/hq/pull/299)** at
`5244cd89b183f069186eb45290019e8059aeb1fb`, specifically its
[complete HQ-085 specification](https://github.com/crossroads-hq/hq/blob/5244cd89b183f069186eb45290019e8059aeb1fb/docs/plans/HQ-085-specification.md),
[sources](https://github.com/crossroads-hq/hq/blob/5244cd89b183f069186eb45290019e8059aeb1fb/docs/evidence/hq-085/SOURCES.md)
and [inactive runbook](https://github.com/crossroads-hq/hq/blob/5244cd89b183f069186eb45290019e8059aeb1fb/docs/runbooks/ci-admission-pilot.md).
That draft's D31 is an explicitly authorized dependency, not merged main.
First CI pilot branch: `codex/ci-admission-contracts`, base `main` at
`efa6bce87fc2d7ff8c6bfaae4815225ee75da546`. No cross-repository Git ancestry.

## Boundary and ownership

`scripts/lib/ci-admission.mjs` is dependency-free ECMAScript: explicit epoch
milliseconds, no ambient clock, I/O, controller, storage, network/vendor adapter,
credentials or write capability. Its predicates are necessary conditions, never
sufficient authorization for a grant, checkout, latch reset or rerun. A model
`Eligible` is not admission. No production workflow imports it. Existing CI
discovers `scripts/*.test.js`; no workflow/action/gate change is needed to run
these tests. No package or infrastructure is introduced.

The module owns canonical keys, closed normalized statuses and small shared
checks. Story 3 owns transactional state/replay, graph/fairness/capacity algorithms
and the disabled shadow controller; Story 4 owns fresh fixed-scope raw fleet data.
Stories 6/8 own trusted permit decoding, native job binding, fencing and disabled
write reconciliation. Source delivery is authorized; live setup, native drills,
owner acceptance/merge and activation remain separate.

The two-repository scope, seven elapsed days, owner ID `37964907`, Actions gate
App `15368`, no preemption and aggregate **600 billed hosted minutes/day** are
approved invariants. `APPROVED` records them; it does not apply them. `CANDIDATES`
records proposed tuning: two managed fast workloads **across both repositories**,
two-minute permits, 5-second launch/60-second ordinary reads, 60-second evidence,
3 recoveries/workload/head/Jerusalem-day, 5-minute cooldown, 24-hour intent,
3 reentries/owner request, 4,200 total hosted minutes, API caps 2,500 reads/hour,
100 writes/hour, 10 writes/minute and 25% remaining headroom. These are neither
platform limits nor activated settings. Scheduler App identity is unknown until
later owner setup; fixtures' App `900` is synthetic, never enrollment.

## Version 1 input/output contract

IDs are positive **safe integer numbers**, never names/strings/floats. Timestamps
are nonnegative integer epoch milliseconds. SHA/digest values are lowercase
40/64-character hexadecimal. Bounded strings reject control characters; they are
identity data, not validated Git paths or executable source. Future adapters must
validate refs/workflow closure and paths before reading. Invalid keys return null.
Invalid/absent/partial/conflicting observations return `Unknown`; never coerce
that to empty, false, zero or permission.

| Export / normalized value | Required contract |
| --- | --- |
| `inputKey(input)` | Ordered `repoId, pr, head, baseRef, baseSha, mergeSha, workflow, digest, workload, capability`. Base is **original native** base, not rewritten latest state. Policy/run/attempt/generation excluded. Persistent success/failure use this key across native runs. |
| `executionKey(execution)` | `repoId, runId, attempt, rootJobId, heavyJobId, generation`; heavy explicitly null until bound. Generation is durable fencing. Does not replace input key. |
| `recoveryKey(input, now)` | `repoId, workload, head, Asia/Jerusalem date`; excludes PR/base/digest/capability/run/policy so a new execution/decision cannot replenish head budget. |
| `ownerRequestKey(request)` | `repoId, runId, ownerAttempt, rootJobId`; owner attempt >1. Persist before App recovery; dedup all reentries/races under this origin. |
| `accountingDay(now)` | Jerusalem date via standard `Intl`; injected clock only. Does not allocate or round bills. |
| `observeList(envelope, now, validate?)` | `{items: [], complete: true, observedAt}` asserts **all** required pages/coverage, unique numeric item IDs, freshness and a closed item decoder where applicable. Known-empty differs from Unknown. Generic validation alone proves no domain fact. |
| Job | `id, repoId, runId, attempt, status, conclusion, role, workload`. `JOB_STATUSES/JOB_CONCLUSIONS` are closed. Unfinished jobs need null conclusion; completed need recognized conclusion. Role `root/heavy/gate/other` comes from **trusted reviewed closure**, never name guessing/PR-supplied role. |
| `permitDecision(envelope, expected, now)` | Exactly one current candidate check: persisted check ID, scheduler App ID, input, actual execution/generation, phase/launch clock, completed/success and fixed 2-minute expiry. Expected: `input, execution, phase, appId, checkId, launchIssuedAt`. Extra/conflicting checks/generations hold. Output `Verified/Unknown`. |
| `releaseDecision(reservation, evidence, now)` | Reservation: execution/mutation state. Evidence adds run `{repoId,id,attempt,status}` and complete ordered `coveredAttempts: [1..N]`, **all jobs across all attempts** including unrelated siblings. Whole run/every job terminal; exact original root/heavy IDs and actual attempt present. Output `Release/Unknown`. |
| `ownerRequests(observation, expected, now)` | Attempt `{repoId,runId,number,triggeringActorId,triggeringActorType,input,observedAt}`, complete attempt-specific jobs, current refs `{input,observedAt}` and permission `{actorId,value,observedAt}`. Expected: representative `input` plus complete trusted `rootInputs` descriptors; each validates same original native refs/workflow/digest, unique workload and explicit capability. Only owner attempt >1/current write-admin yields roots actually rerun, each with its enrolled full input. Bot/initial/heavy-only/gate-only yields no new request. |
| `failureLatch(previous, {checkpoint,outcome})` | Checkpoint `before_checkout/after_checkout/unknown`; outcome `held/success/failure/unknown`. Add-only: genuine/ambiguous unsuccessful checkout or unknown checkpoint latches. Later Held/success never clears. Invalid evidence gives null (Unknown), never erase instruction. |
| `recoveryDecision(record, now)` | Input, original priority `readyAt`, separate durable `intentCreatedAt`, `lastRecoveryAt` or null, daily/request counts, success/failure latch booleans and scoped owner request or null. A new eligible owner request starts its own waiting intent; App reentries preserve that intent clock. All bounds together; cooldown/24-hour **intent** expiry exact. Output `Eligible/Held/Unknown`; no mutation. Revalidate owner request before every effect. |
| `newWorkDecision(state, now)` | Later owner activation record (ID, ownerAuthorized, start, exact 7-day expiry), paused/revoked, backoff clock, rate counters/headroom and Known aggregate accounting. Both rate/accounting require `complete: true` and fresh `observedAt`; partial/missing/stale/future clocks give Unknown. Synthetic activation in tests only. Missing authority Unknown. Self-hosted design requires zero-hosted closure and no hosted reservation/usage; unexpected/unknown usage stops work, remains in accounting. Output `Eligible/Held/Unknown`. |

Adapters must prove envelope assertions from authoritative fixed-scope data;
`complete: true` is not a GitHub proof. Permit-list scope is expected current
input/generation/phase after complete check coverage; never filter away conflicting
current candidates. Historical generations remain evidence, never fresh authority.
Names/conclusions/old root outputs alone do not count. Current authoritative
head/base/test-merge/digest must match original inputs; changes need new native run.

## Durable protocol for later stories

`PHASES` closes Waiting/Held/Reserved/Bound/Active/Completed/Failed/Stale/Unknown.
Vocabulary, not state-machine implementation. Persist input/execution, policy,
first-ready time, clocks, owner request and fixed reason. Atomically persist
shared reservation and mutation **intent before** targeted-root rerun. `MUTATIONS`
separates none/intent/confirmed/unresolved: confirmed means reconciled effect,
never just 2xx. Lost/unknown response prohibits blind retry or duplicate checks.

Initial roots reserve/bind without rerun. Actual-root launch verification does
not require heavy ID and can finish first. Heavy preflight then waits briefly
(candidate 30 seconds) for exact-job checkout evidence **before checkout**.
Publish checkout strictly before launch's 2-minute deadline; checkout lasts
2 minutes from publication. A live published checkout may be consumed after
launch deadline; late publication/renewal cannot revive launch. At deadline fence
unbound launch Held and keep reservation. 5-second reconciliation is bounded by
launch, then ordinary reads. Root check/job timeout candidates: 30 seconds/2 minutes.
Native dispatch has no timing guarantee.

Lease/permit expiry, timeout, newer attempt, restart or acknowledgement cannot
release capacity. Preserve older actual-job obligations. Release says only exact
graph terminal; classification/accounting/durable commit still required. Reruns
add current eligibility and whole-run reconciliation, one root plus dependents
only, successful siblings retained at original attempt/jobs; no whole-run/all-failed
retry. Persist input-key success/failure, head/day counts, owner dedup/reentries
and first-ready time atomically. Waiting intent creation is separate from original
PR-ready priority: a fresh owner request on an old PR gets its own 24-hour intent;
App retries cannot reset that clock. App attempts inherit requests, never manufacture
authority. Owner rerun of successful root requests new work; resets no other bound
or workload. Pure recovery predicate does not implement durable inheritance/claims.

Capacity DTOs require complete current runner/group/repo eligibility, numeric
runner/job IDs, measured physical-group constraints, labels, source clocks,
unmanaged occupancy and bound reservation mappings. Count labels once, reservation
plus job once, both repos together. Unknown/shared-light occupancy reduces room or
holds. Fixture 19/20/21 topology is dated, not three promised independent executors.
Persist round-robin cursor, one workload/stack/pass, unique same-repo open-head
edges, ancestor pending-work priority, descendant spare use, oldest-ready/stable
numeric tie-breaks, mandatory before AI. Ambiguous/cyclic/incomplete graphs hold;
genuine failed ancestor without retry is not pending. No queue-rank/dispatch claim.

Per-job ledger retains repo/run/actual attempt/job/input/generation, runner type,
lifecycle clocks, rounded billed minutes **or Unknown**, local dates, evidence
source/reconciliation clocks and aggregate day/total amounts. Cross-midnight
allocation/rounding is an explicit Story 3/8 decision and tested activation
blocker; this slice invents no billing rule. Never reclassify hosted usage or
unknown-as-zero. Pause/expiry/rate/backoff/budget uncertainty suppress **new**
grants/reentries, retain expiry and drain without cancellation. Existing short
permits retain only recorded rights. No scheduler cancellation operation exists.
Append-only audit records actor/request, target/input/generation, policy/reason,
clocks and intent/result; unresolved obligations survive until reconciled and
owner-approved archival. Retain no source bodies/logs/secrets.

## Acceptance and proof mapping

Run `node --check scripts/lib/ci-admission.mjs` and
`node --test scripts/ci-admission.test.js`. Required repository validation:
`bash scripts/validate-local.sh` plus `node --test scripts/*.test.js` (preflight
currently omits that CI suite). No TypeScript/build step exists here.

| HQ-085 / #129 obligation | Executed pure evidence | Deferred proof/owner |
| --- | --- | --- |
| 1 identity/reset resistance | Every input field; second run/policy exclusion; execution/generation; head/day/request keys | Atomic persistence/restart, Story 3 |
| 2 closed/Unknown/provenance | Invalid IDs; missing/non-list/partial/stale/future/duplicate lists; wrong App/check/jobs/refs/digest/generation | Decoders/complete pagination, Stories 3/4/6/8 |
| 3 two-stage permits | Root without heavy; exact checkout; exact expiry/phase offsets/>2-minute delay/no late publication | Trusted steps/native timing, Stories 6/8/9/10 |
| 4 terminal release/mutation | Active old jobs, newer attempt, incomplete coverage, intent/unresolved/2xx/restart/lease expiry never release | Durable transaction/write reconciliation, Stories 3/8 |
| 5 recovery/latch | UI Verify/Storybook predicate model keeps original sibling; ambiguous failure latch/retry bounds | Actual native targeted graph/required gate, Stories 6/8/10 |
| 6 owner scope | Attempt actor/current permission/refs, all/selected roots vs heavy/gate, App no request, dedup key | Durable claim/race/inheritance/rechecks, Stories 3/8 |
| 7 fairness | Machine-readable graph and falsifiable ordering expectations | Graph/cursor/round-robin implementation, Story 3 |
| 8 capacity | Both repo IDs, overlapping labels/physical group and expected holds | Capacity algorithm/fresh reader, Stories 3/4 |
| 9 limits/clocks | 3 counts, exact 5-minute/24-hour boundary, midnight/spring/fall DST | Durable race-safe charging, Stories 3/8 |
| 10 no preemption | Pause/revoke/expiry/backoff; unchanged expiry/no effects | Drain/rollback/native cancellation separation, Stories 3/8/9/10 |
| 11 accounting/API | Unknown/unexpected hosted stop; zero-hosted predicate; candidate rate/headroom | Closure audit, lifecycle allocation/rounding/rate load tests, Stories 3/8/9/10 |
| 12 proof matrix | Executable predicates plus fixture manifest with deferred owners | Native drills separately owner-authorized after protected setup, before activation |

`scripts/fixtures/ci-admission.json` contains pure recovery cases and future replay
expectations. Its manifest shape check does **not** execute fairness/capacity/
persistence/billing algorithms. No model result proves GitHub native semantics.
Source-bound `PR Validation` App15368, separate scheduler App identities, protected
private reader/service bindings, runtime proofs and owner setup remain gates.

## Delivery and next handoff

In-context author: Codex / GPT-6, model/mode unchanged. Canonical Portfolio Manager,
Architecture Review, Engineering Principles and existing role adapters read via
`git show` at skills revision `643dfa879cc16b9572d1e7255a6b4e619c2a1579`; no copies.
Independent actual-diff review is posted separately on the draft.

Existing structures: HQ-085 direction **Still valid** (rank 1 owner decision,
explicitly authorized unmerged dependency); gate/shared-action trust contract
**Still valid** (trusted-base AGENTS); dependency-free test discovery **Still valid**
(rank 4 CI tests). Preserve all; no consumer migration. Preflight's omitted fleet
script tests: **Valid but improvable** (rank 4 CI comparison); run explicitly here,
leave preflight repair to its own follow-up.

From: CI Engineering / Portfolio in-context author. To: Story 3 engineer and
independent verifier. Work item: disabled shadow controller/durable replay.
Decision/request: branch from and target this CI draft, without merge wait.
Context: HQ #299 exact dependency/#129 evidence above. Evidence: pure tests,
final diff, local gate and posted independent review in draft PR. Findings:
bounded model validated, live behavior unknown. Confidence: model only.
Assumptions: later decoders prove DTO assertions. Risks: native semantics,
async timing, topology/billing remain unproved. Dependencies: exact heads/pins
in next chat. Recommendation/requested action: implement only Story 3 and retain
later gates. Acceptance: durable restart/fault replay without writer/activation,
signed draft/independent review. Open questions: accounting allocation/live proofs
remain owned blockers. Review date: 2026-11-21.
