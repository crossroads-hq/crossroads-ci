# HQ-085 Story 3 — disabled durable shadow controller

Stack: CI draft [#130](https://github.com/crossroads-hq/crossroads-ci/pull/130)
at `ca28d41a3dc7741c4086f3d047198281b2fb1919`. This story branches from and
targets `codex/ci-admission-contracts`; it does not change that predecessor.
Authority is HQ draft [#299](https://github.com/crossroads-hq/hq/pull/299) at
`5244cd89b183f069186eb45290019e8059aeb1fb`, especially the complete
[HQ-085 specification](https://github.com/crossroads-hq/hq/blob/5244cd89b183f069186eb45290019e8059aeb1fb/docs/plans/HQ-085-specification.md),
[source record](https://github.com/crossroads-hq/hq/blob/5244cd89b183f069186eb45290019e8059aeb1fb/docs/evidence/hq-085/SOURCES.md)
and [inactive runbook](https://github.com/crossroads-hq/hq/blob/5244cd89b183f069186eb45290019e8059aeb1fb/docs/runbooks/ci-admission-pilot.md).
These are approved unmerged dependencies. Neither is claimed merged main or
runtime acceptance. Acceptance mapping below also links existing [CI #129](https://github.com/crossroads-hq/crossroads-ci/issues/129)
and [HQ #298](https://github.com/crossroads-hq/hq/issues/298).

## Boundary and architecture

`scripts/lib/ci-admission-shadow.mjs` implements a **DISABLED_SHADOW** model.
Every response and snapshot has `effects: []`. Reservations retain their synthetic activation identity; a different activation cannot revive old rights. No switch can enable writes.
There is no Worker entry point, deployment configuration, polling, alarm,
network client, credential, cancellation or effect executor. Only local SQLite
writes occur in tests. No production workflow imports this code. Story 8 owns
the disabled external writer and eventual Worker wiring; source delivery is not
permission to provision, deploy, rerun, activate, merge or mark a draft ready.

The only policy dependency is Story 2's shared `ci-admission.mjs`; no vendor
adapter duplicates its identities or predicates. `ShadowController(storage)`
accepts the synchronous SQLite Durable Object port:
`sql.exec(statement, ...bindings).toArray()` and `transactionSync(callback)`.
Exactly **one future SQLite object coordinates both repositories**; no per-repo
shards. Schema creation, state recovery and each command are synchronous, with
no await between related operations. All commands re-read storage; there is no
in-memory authoritative cache. SQL uses fixed statements and bound values.
This follows the platform's [synchronous transaction contract](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/#transactionsync).
Cloudflare runtime integration is deferred; file-backed Node SQLite exercises
the actual schema/rollback/reopen behavior, not Cloudflare deployment or gates.

Two tables hold a versioned state row and append-only command/audit receipts.
Reservation, mutation intent, daily/cooldown/request charges, cursor, decision,
and audit receipt commit together. A crash rolls back all of them. A duplicate
positive numeric command ID returns its original receipt and cannot mutate
again, even if resent with different content; callers must never reuse IDs for
new commands. Invalid/corrupt/version-mismatched state or a backwards clock
throws a fixed Unknown error, never resets state. Missing state with existing
audit is an error. There is no cleanup/reset operation.

Bounds: 512 inputs, obligations and owner requests; 2,048 accounting rows and
head/day keys; 10,000 committed commands. Full tables stop safely, retaining
obligations. These are bounded local-model limits, not production retention or
throughput promises. Future retention/migration/load tests and owner-approved
archival must resolve saturation before activation. The state row includes
operational immutable identities, classifications, clocks and counters only;
raw command bodies, API errors, PR text, source, logs and secrets are not stored.

## Supplied evidence and commands

This model consumes **trusted normalized assertions**, not raw GitHub responses.
`complete: true` asserts all required pages/attempts/closure were read; it cannot
prove them. Story 4's fixed reader, Story 6's verifier and Story 8's writer must
establish provenance, closure, exact App/installation enrollment, current refs
and complete coverage. Fixture App `900` and synthetic activation IDs are never
real enrollment or owner activation. Caller-supplied fields cannot be treated
as production authority merely because this model accepts them.

`apply({id, now, policy, type, ...payload})` uses explicit epoch milliseconds.
Policy/type are bounded identifiers; inputs/executions are projected through
the shared canonical contracts. Snapshots never imply physical dispatch order.

| Command | Durable model behavior |
| --- | --- |
| `queue` | Retain first-ready and waiting-intent clocks, input-key success/latch across native runs and policy changes. Same completed execution cannot be reintroduced as initial work. |
| `owner` | Shared attempt-specific owner decoder; dedup original owner-attempt/root key, scoped latch clearing, fresh intent with original ready priority. App attempts cannot mint a request. |
| `decide` | Fresh complete two-repo graph/current-input/capacity/safety evidence; stack fairness; atomic shared reservation, targeted-root mutation intent and all applicable bounds. No action executes. |
| `lost` / `bind` | Intent becomes unresolved after lost response. Reconcile exact actual root/attempt/jobs against persisted simulated App identity before confirming; extra targeted-recovery roots/duplicate job authority hold; legitimate initial native sibling roots remain valid. No acknowledgement/2xx command exists. |
| `permit` / `consume` | Record one simulated launch then checkout check, exact generation/App/check/job binding, fixed two-minute phases; checkout strictly before launch expiry, once-only exact consumption. Root launch needs no heavy ID. Freshness/owner/safety rechecks before each new publication. |
| `tick` | Fence late/unbound/expired short rights Held; preserve reservations. Five-second reconciliation only within launch, otherwise 60 seconds; no scheduler runs here. |
| `settle` | Shared complete exact whole-run/all-attempt terminal prerequisite; no unresolved intent release. Retain successful sibling at original execution, add-only genuine/ambiguous latch, fulfill scoped request only after checkout/ambiguous result. Require observed current heavy binding and retain unknown older/manual heavy mappings; create durable Unknown accounting for missing actual root/heavy records. |
| `ledger` | Actual generation/job attribution, runner type, lifecycle/source clocks and externally supplied rounded minutes or Unknown. Unknown fields may monotonically reconcile to authoritative lifecycle/billing; conflicting known records refuse. |
| `snapshot(now)` | Version/mode/model-update/view clocks and stale flag, cursor, inputs/latches, live obligations and released history, permits, request/daily counts, accounting, ledger and explainable last decision. Effects always empty. Model-update time is not upstream evidence freshness; Stories 4/5/8 must report actual source clocks/coverage separately. |

Rerun intent records both the old **original actual root** and the expected next
attempt from the latest reconciled **whole run**. Omitted sibling jobs are never
renumbered into the latest attempt. Recovery charges aggregate by workload/head/
Jerusalem day and cooldown across days; request reentries include unresolved
claim races. All bound checks, owner permission/current-input rechecks, three
reentries, three/day, five-minute cooldown and 24-hour **intent** expiry apply
together. App reentry and duplicate owner observation never refresh intent time.

## Fairness, capacity and accounting choices

Complete open-PR evidence covers both repositories, including non-ready ancestors.
Edges use unique same-repo open heads. Ambiguity/cycles/unreadable/incomplete
coverage hold. Pending eligible ancestors precede descendants; failed ancestors
without retry are not pending. Admitted ancestors leave the pending set, so
spare room can serve descendants before an ancestor passes. Mandatory work
precedes advisory work on the same PR. Stacks rotate after the durable cursor,
one workload per stack per pass, selecting the topological pending frontier before ready-time ordering; oldest original ready then stable numeric repo/
PR and workload order resolve ties. No queue rank or physical start order is
inferred. A new unresolved mutation serializes further recovery in its run.

Capacity is deliberately conservative **worst placement**. Distinct runner IDs
count once despite overlapping labels; every relevant physical group must have
room for all managed reservations plus its unmanaged occupancy. Usable runner
eligibility and measured group slots must be explicit/fresh. This may hold
otherwise usable independent capacity, a documented safety trade-off while
GitHub chooses physical dispatch. It never assumes three WSL labels mean three
independent machines. A bound actual job carrying its matching generation is
already represented by its reservation. The candidate ceiling remains two
**total across both repositories**, never two per repo or label. Unknown topology,
coverage, eligibility, duplicate jobs or unmapped occupancy holds.

**Cross-midnight billing allocation remains UNRESOLVED_ACTIVATION_BLOCKER.**
No rounding/allocation policy is invented here. Supplied per-job rounded totals
are retained; a lifecycle crossing Jerusalem dates has no allocated day, and
daily/aggregate accounting stays Unknown. DST/midnight fixtures assert this.
Missing job billing creates durable Unknown rather than zero; Unknown blocks
new simulated rights until reconciled. Unexpected hosted execution remains
visible pilot usage and stops new work even if supplied aggregate safety says
zero. The self-hosted source model requires complete zero-hosted closure and no
hosted reservations. Approved 600 total/day, proposed 4,200 total, API caps and
25% headroom remain shared contract candidates/owner gates, not applied budgets.
Pause/expiry/revocation/rate/backoff/budget uncertainty suppress new rights,
preserve issued short rights/obligations and original expiry, and drain without
cancellation.

## Executed acceptance and deferred proof

Run `node --test scripts/ci-admission-shadow.test.js` (Node 22+ SQLite support;
Node 24 used locally), `node --test scripts/*.test.js` and the repository
`bash scripts/validate-local.sh`. Existing CI already discovers `scripts/*.test.js`;
no gate/workflow change is required. The new fixture's events are executed by
its partial-recovery test, not counted as proof from their manifest shape.

| HQ-085 obligation | Executable Story 3 evidence | Remaining owner |
| --- | --- | --- |
| 1/4 atomic durability | Real SQLite reopen, shared DB reread, audit-trigger fault rollback, duplicate command, retained intent/obligations, corrupt/versioned/backwards-clock rejection | Story 8 Cloudflare runtime/load/fault deployment |
| 2/3 provenance and timing | Shared contract checks plus exact two-stage simulation, stale/duplicate/late publication, root without heavy, post-launch live checkout, old active attempts/partial coverage | Stories 6/8 actual native/check provenance and timing |
| 5 partial recovery | Executable `fixtures/ci-admission-shadow.json`: Verify attempt 2 then Storybook attempt 3, original omitted root/successful sibling retained | Stories 6/8/10 separately authorized GitHub drill and native required gate |
| 6/9 owner/latch/bounds | Genuine/ambiguous latch across run/policy; heavy-only none; permission loss; owner duplicate/App inheritance; three race-inclusive reentries, retained clocks/counts | Story 8 raw actor/permission/ref/closure decoder and live race proof |
| 7/8 fairness/capacity | Ancestor/mandatory order, descendant spare use, cursor restart, round robin, ambiguous/cyclic/stale graph, overlapping runner labels, bound-job dedup, unmanaged/physical Unknown, two-repo ceiling | Story 4 fresh fixed reader; later measured topology/load/dispatch evidence |
| 10/11 drain/accounting | Pause/rate/expiry no new rights; retained permits/obligations; Unknown job lifecycle; unexpected hosted; midnight and both DST boundaries hold unallocated totals | Story 8 allocation decision/accounting completeness/API load; consumer zero-hosted closure, live rollback |
| 12 delivery boundary | No effects/entry point/config/credentials; local deterministic replay and independent final-diff review | Owner acceptance, main adoption, protected setup, native drills and explicit later activation |

In-context author: Codex / GPT-6, unchanged model/mode. Canonical Portfolio,
Architecture Review, Engineering Principles and existing role adapters consulted
at skills revision `643dfa879cc16b9572d1e7255a6b4e619c2a1579`. Independent
review is performed by a separate agent and posted on this draft.

Existing decisions: one shared contract and one object/both repos **Still valid**
(rank 1 approved HQ-085, explicitly authorized draft dependency); current gate,
shared actions/defaults/pins **Still valid** (trusted-base AGENTS; untouched);
script test discovery **Still valid** (rank 4 CI). Local preflight omission of
script tests remains **Valid but improvable** (rank 4 comparison); explicitly
run them, leave unrelated preflight repair to its own follow-up. Per-repo objects,
in-memory authority and a production polling/writer in this slice were rejected:
they respectively split capacity, lose obligations, or cross the story boundary.

## Handoff

From: CI Engineering / Portfolio, in-context author.
To: HQ-022 Story 4 owner and independent verifier.
Work item: fixed private fleet reader and protected Status evidence.
Decision or question: continue serially in its own chat, stacked on HQ draft #299.
Context: approved HQ-085 ten-story stack; no merge wait; no provisioning/activation.
Evidence reviewed: exact source dependencies above, local replay/tests, final diff and posted independent review.
Findings: source-only durable model delivered; live/native semantics unknown.
Confidence: local deterministic behavior only.
Assumptions: future trusted adapters prove normalized assertions.
Risks: conservative physical holds; bounded state saturation; unresolved billing and runtime setup.
Dependencies: HQ #299, CI #130 and this draft; narrow existing HQ read App/fixed ws_company scope/private bindings.
Recommendation: implement Story 4 only; preserve HQ-022/023/079/040/041/049 ownership and protected hosts.
Requested action: accept or return missing evidence; carry serial owner authorization through Story 10.
Acceptance criteria: Story 4's own bounded issue, source-only fixed reader/protected Status evidence, local checks, independent review, signed verified draft, explicit Codex request and clean handoff.
Open questions: cross-date allocation, topology/load/native proofs and manual owner protection/App/infra/activation gates remain deferred; missing live infra does not block safe source work.
Review date: 2026-11-21; refresh mutable draft/review status before successor edits.
