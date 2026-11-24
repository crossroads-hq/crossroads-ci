# HQ-085 Story 8 — disabled permit/recovery writer

Tracking: [CI #129](https://github.com/crossroads-hq/crossroads-ci/issues/129),
[HQ #298](https://github.com/crossroads-hq/hq/issues/298).
FROM/TARGET exact Story 7 `codex/ci-admission-ai` at
`31c1e265fc0741ddb1de4a550e0a94337d6b1973` (draft #133).
Approved unmerged source dependencies are not runtime acceptance.

## Candidate findings recorded before correction

- Separate read-only agent `/root/review_story8` found that persisted write
  validation accepted arbitrary POST/PATCH paths without binding the stored
  request to its obligation. Reconstruct the exact request from durable
  kind/input/execution/generation/check ID/clocks and reject corrupt paths,
  bodies or identities on reopen and before fencing. Add SQLite tamper tests.
- Author inspection found the inert creation check used a permit name, while
  the pinned Story 6 decoder requires self-identifying JSON for every check
  under a permit name. Create under a separate pending name and rename only
  with the final self-identifying publication. This preserves bounded polling.

Further independent candidate findings (recorded before correction): local rate
reservations disappeared behind a newer rate observation even when undispatched;
count outstanding intents independently and conservatively retain current-window
writes. Writer audit lacked normalized source windows/coverage, App identity,
remaining bounds and targeted deltas; add bounded event records instead of copying
all history per event. Finally, a local pre-deadline fence cannot prove a remote
PATCH completed before the deadline. Reject delayed checkout receipts locally;
**CHECKOUT_REMOTE_PUBLICATION_DEADLINE_UNPROVEN** remains an explicit enrollment /
activation blocker: the pinned Story 6 reader does not independently enforce a
server publication clock. Source-only fixtures do not waive this distributed
write boundary. Later reviewed writer/verifier source and bounded native proof
must resolve it before any enrollment/activation.

## Delivered boundary and durable ownership

`scripts/lib/ci-admission-writer.mjs` is an inert protocol extension inside the
existing `ShadowController` transaction. One future SQLite object owns BOTH
repository IDs `1318535693` and `1305651079`. `mode: DISABLED`, `effects: []` and
empty compiled action enrollments remain fixed. There is no Worker entrypoint,
HTTP client, dispatcher, credential read, binding, route, schedule, deployment,
configuration activation switch or infrastructure. Requests in local snapshots
are reviewable deterministic declarations, never authority to send them.

Canonical `choose`, `bind`, `permit`, `releaseDecision`, owner and safety predicates
remain their existing owners; the writer delegates instead of copying policy.
The state adds a bounded writer journal without replacing the v1 inputs,
obligations, released history, fairness cursor, daily counters, original ready /
intent clocks, owner requests, failure latches, activation identity or ledger.
An old state with no writer obligations upgrades additively on its first writer
command. Missing writer state after writer obligations exist is corruption and
refuses reopen. No cleanup/reset/resume command exists. Audit failure rolls back
reservation, write intent, counters, cursor and receipt together.

A future native adapter must establish every normalized frame assertion from
complete bounded authoritative reads: numeric repository resolution/re-fetch,
original native refs/workflow closure, full open-head coverage, all attempts/jobs,
exact App/installation/actor identity, current owner write/admin permission,
source-bound native gate protections, measured fleet topology/occupancy and
all-consumer rate/accounting. This slice validates and persists those DTOs in
synthetic local fixtures; it does **not** implement that adapter or prove those
facts. In particular `writer-bind`'s App attribution is an adapter assertion,
not a native API decoder. Neither a fixture's `complete: true` nor an Eligible /
Verified predicate establishes runtime authority. Unknown billing is never zero.

| Declared write | Fixed capability |
| --- | --- |
| POST `/repos/crossroads-hq/{fixed-repository}/actions/jobs/{original-actual-root-ID}/rerun` | Root plus native dependents only; whole-run/all-attempt terminal prerequisite; one recovery per run; no caller path, debug logging false |
| POST `/repos/crossroads-hq/{fixed-repository}/check-runs` | Inert pending check on exact test-merge SHA; fixed phase/workload/generation, no successful permit payload |
| PATCH `/repos/crossroads-hq/{fixed-repository}/check-runs/{reconciled-assigned-ID}` | One fixed self-identifying permit publication, completed/success, immutable input/execution/App/ID/generation and clocks |

`fixed-repository` is derived only from the two approved numeric IDs. Origin is
always `https://api.github.com`. Every method/path/body is reconstructed from
its durable obligation on reopen and before fencing. The interface accepts no
URL, arbitrary check name, operation, token, raw proxy or caller-provided body.
It cannot name `PR Validation`, rerun a whole workflow/all failed jobs, target a
heavy/gate job, cancel, mutate refs/content/PR/settings/runner groups or deploy.
The owner must separately establish repo-scoped native App15368 gate protection
before enabling any later Checks:write credential. No such setup occurred here.
These capability declarations follow GitHub's [job rerun](https://docs.github.com/en/rest/actions/workflow-runs#re-run-a-job-from-a-workflow-run)
and [create/update check-run](https://docs.github.com/en/rest/checks/runs) APIs.

## Write protocol and reconciliation

1. `writer-reserve` calls canonical shared selection and, for recovery, records
   the exact targeted rerun intent in the SAME transaction. Recovery counts,
   request reentries and cooldown are charged before any possible write. Initial
   roots reserve without a rerun. Failed guarded batches roll back completely.
2. `writer-prepare` persists one create or publish intent per generation/phase.
   Initial check creation has no assigned ID and uses `CI admission pending /
   PHASE / WORKLOAD`, which the pinned reader ignores while polling. Empty
   complete current-execution check evidence is required before the first create.
3. `writer-fence` rechecks current refs, enrollment, owner authority, protection,
   shared retained feasibility, safety, accounting and all-consumer rate evidence.
   Rerun fencing also rechecks exact latest whole-terminal attempt. Within five
   seconds of preparation it durably marks the intent **unresolved**. A future
   executor would commit this before one network attempt; none is supplied here.
   No response contains executable effects or a replayable dispatch grant.
4. `writer-reconcile` requires exactly one complete, fresh current-execution
   check observation matching App, merge SHA, generation/phase/name, body and
   assigned ID. Creation confirms only the ID. A separate durable PATCH intent
   is then required to publish self-identifying `hq-085-permit-v1` JSON. Changed,
   duplicate, partial, malformed or conflicting observations hold. Empty evidence,
   timeout, restart and HTTP status alone never authorize replacement/retry.
5. `writer-bind` confirms a recovery only with the exact modeled expected next
   attempt/root/jobs and original inputs/App assertion; an owner/App race with a
   different attempt holds and retains the obligation and spent reentry.
   `writer-bind-heavy` retains the observed actual heavy ID; it grants no right.
6. Publication uses the canonical permit transition on a disposable state for
   eligibility and wire construction. Launch and checkout keep fixed two-minute
   clocks from the conservatively recorded pre-write publication intent time;
   no latency or receipt can extend them. Checkout preparation/fencing and its
   positive observation must precede launch expiry. A live checkout confirmed
   before launch expiry can be consumed afterward until its own expiry. The
   actual remote visibility boundary remains blocked as stated above.
7. Only complete exact whole-run/all-attempt terminal evidence can settle and
   release; unrelated active/omitted older siblings still count. Outstanding
   intended/unresolved writes prohibit settlement. Legacy shadow permit/bind/lost
   commands cannot bypass the writer journal for writer-managed obligations.

All commands share the existing append-only SQLite audit and re-read durable
state. Writer command IDs bind a stable SHA-256 command digest: a replay returns
only the saved inert receipt, while a different command at that ID refuses.
Writer audit stores changed write records plus targeted generations, original
inputs/executions/App/owner keys, policy/reason, source observation/coverage windows,
owner attempt/permission/ref provenance and normalized remaining recovery/reentry /
API headroom/budget bounds. It does not store credentials, source bodies or logs.
A local model-update timestamp never refreshes upstream evidence.

Undispatched intents remain rate reservations across newer external snapshots.
All locally fenced writes in the current minute/hour remain conservatively
counted, including unresolved and already confirmed writes. External counters
must cover every consumer, page and reconciliation read. Double counting can
hold safe throughput; it cannot create budget. Canonical proposed limits remain
2,500 reads/hour, 100 writes/hour, 10/minute and 25% headroom, not activated values
or GitHub platform limits. Self-hosted admission requires known zero-hosted closure;
the approved shared 600 minutes/day and proposed 4,200 total remain unconfigured.

## Pause, drain and rollback

Pause/revocation/backoff/rate/budget Unknown/expired activation reject new write
preparation/fencing. Already published short rights keep only their original
expiry. `writer-stop` permanently fences all undispatched intents, increments
the local epoch and holds managed obligations without cancelling any job or
editing any check. Already fenced uncertain writes may only reconcile; a known
late checkout receipt still holds unresolved. History, counters, latches, owner
requests, accounting and pending obligations remain. Stopping, seven-day expiry,
a newer attempt, HTTP 2xx and restart never free capacity. Later rollback requires
separate owner control over deployment/credentials/enrollment, authoritative
native drain and retained audit/backups; no deletion, revoke or rollback command
is sent to GitHub by this source. The original activation expiry is never extended.

## Acceptance and evidence mapping

| #129 / HQ #298 contract | Deterministic executed evidence | Remaining proof |
| --- | --- | --- |
| Atomic reservation / every write intent | Real SQLite rollback trigger; initial-create and separate publication records; reopen/lost-ack and digest-collision cases | Cloudflare deployment/storage/fault proof; no runtime wired |
| Exact fixed capability / provenance | Corrupt stored method/path/body/input/execution/phase/clock refuses reopen/fence; wrong App/head/generation and duplicate/partial checks hold | Native adapter complete pagination/closure/App identity and installation proof |
| Whole-run recovery / race | Targeted root request only; App next-attempt fixture, race/2xx hold; inherited partial sibling/owner/head-day/cooldown tests remain green | Separately bounded native partial Verify/Storybook/gate and owner race drills |
| Two-stage permits / no renewal | Pending name, assigned ID and distinct publication; heavy bind, expiry/deadline refusal; live checkout consumed after launch expiry; whole-terminal-only release | Remote publication deadline blocker; pinned verifier/native proof |
| Pause/drain/rollback | Permanent stop keeps unresolved publications/reservations; reconciliation retains fixed clocks; no effects; inherited pause/expiry/backoff/accounting cases | Later owner-controlled setup, credential/enrollment rollback and observed native drain |
| Owner / rates / audit | Permission loss at fence; persisted owner source clocks and remaining reentries; fresh rate snapshot cannot erase intent; targeted audit deltas | Shared live all-consumer/page/rate measurements and externally proven DTOs |
| Billing / pilot | Inherited actual-job lifecycle/missing/null/DST/midnight/hosted-fault cases; no budget applied | CROSS_DATE_BILLING and owner activation still blocked |

Existing authority structures: canonical policy/shared object **Still valid**
(rank 1 approved HQ-085 spec; rank 4 SQLite contracts). Trusted action/gate/fork
boundaries **Still valid** (trusted-base AGENTS / Story 6 source contracts).
Durable shadow receipt **Valid but improvable** (rank 4): add writer digest,
compact delta/audit source windows without changing existing policy or workflows.
A separate writer database or per-repository coordinator was rejected because
it would split atomic shared capacity and fencing. A live executor was excluded
because this delivery authorizes disabled source and fixtures only.

Run `node --test scripts/ci-admission-writer.test.js`, all `scripts/*.test.js`,
and the explicit full local gate before every push. This repository has no
TypeScript/package/build step. Native GitHub semantics, protected setup,
actual installed credentials, owner acceptance/merge/deploy/activation are unproved.
Final local and independent review receipts are appended after execution and
posted on the draft; a review request is distinct from a completed review.

## Source inheritance and next handoff

The Story 6 `docs/ci-admission-actions-source.sha256` is retained as its historical
exact-source record; its controller hash is superseded here. Verify those nine
hashes against Story 6 `31b0f172dd985ea3fe1c45ee8eb4de35d4f02cc2`, and the other
eight unchanged files against this checkout. The new writer source manifest
records this draft's two modules and writer tests. Trusted action source,
canonical pure predicates, native decoder, both reviewer workflows, current
full-SHA action pins, native gate and consumer enrollments stay unchanged.

From: CI Engineering / in-context Portfolio, Architecture and Engineering review.
To: independent final-diff verifier, then Story 9 Evolution engineer.
Review date: 2026-11-21. Outcome: source-only disabled writer contract, confidence
limited to local SQLite/model fixtures. Required action: deliver one locally
SSH-signed draft stacked on exact Story 7, obtain/post independent review and
explicit Codex review, then start Story 9 in its own LOCAL Evolution chat.
Story 9 refreshes main and implements only dormant native Validate/AI wiring,
with exact CI source pins and all activation blockers retained. It owns Story 10's
serial local UI successor. Do not enroll, provision, activate, merge, mark ready,
change predecessor branches or interpret a green model as native acceptance.

Final candidate audit supplement (recorded before correction): the independent
reviewer reproduced an initial frame persisting unvalidated extra owner-check
text into audit. Project only observations canonically validated for the exact
durable owner keys targeted by that writer event. Unrelated/unconsumed owner
entries are not audit authority or stored text. Add the direct regression.

## 2026-11-24 service review repair (recorded before correction)

Current published draft #134 head `ce38e923872316a8e1c7b4953be0cfee79f4c1e3`
has four P2s in service review `6003647494`, verified against current source:

- `discussion_r4651211323`: a confirmed create with a lost/null assigned ID
  reopens and substitutes the trial sentinel into a durable publication target.
  Require a positive confirmed assigned ID and refuse publication without it.
- `discussion_r4651211332`: stop changes a published obligation from Reserved
  to Held without a changed journal row, leaving audit targets/App empty.
  Include every changed managed obligation and its execution/owner/permits.
- `discussion_r4651211338`: malformed rejected safety data is projected raw
  into audit bounds. Retain only validated bounded scalars; unknown safety
  evidence contributes null bounds, never external objects/text.
- Review body: stop before a recovery rerun's dispatch fences the journal but
  leaves mutation intent, preventing authoritative terminal drain forever.
  Record that no mutation was dispatched, retain journal/counters/reentry charges,
  and still require complete whole-run/all-attempt terminal settlement. A fenced
  uncertain write must remain unresolved; stop and time never release capacity.

Prepare a signed local repair commit without pushing while the coordinator
reconciles upstream Stories 2/3/6/7. After the final Story 7 head arrives, merge
it forward, run full checks/re-review, and publish one combined validated batch.
No successor dispatch is authorized by this repair. All three existing activation
blockers, dormant source behavior and absent executor remain unchanged.
