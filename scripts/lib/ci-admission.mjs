// HQ-085 model primitives. No I/O, ambient clock, credentials or grant/mutation effects.
// Eligible/Verified is one predicate, never sufficient authority to execute work.
export const APPROVED = Object.freeze({ repoIds: Object.freeze([1318535693, 1305651079]),
  ownerId: 37964907, gateAppId: 15368, pilotMs: 7 * 86400000, hostedMinutesDay: 600,
  timezone: 'Asia/Jerusalem', preemption: false });
// Reviewable specification candidates, NOT applied settings or platform limits.
export const CANDIDATES = Object.freeze({ managedFast: 2, permitMs: 120000,
  evidenceMs: 60000, launchPollMs: 5000, ordinaryPollMs: 60000,
  recoveriesDay: 3, reentriesRequest: 3, cooldownMs: 300000, waitingMs: 86400000,
  hostedMinutesTotal: 4200, readsHour: 2500, writesHour: 100, writesMinute: 10, headroom: 0.25 });
export const PHASES = Object.freeze(['Waiting', 'Held', 'Reserved', 'Bound', 'Active',
  'Completed', 'Failed', 'Stale', 'Unknown']);
export const MUTATIONS = Object.freeze(['none', 'intent', 'confirmed', 'unresolved']);
export const CONTRACT_VERSION = 1;
const INPUT = ['repoId', 'pr', 'head', 'baseRef', 'baseSha', 'mergeSha', 'workflow',
  'digest', 'workload', 'capability'];
const EXECUTION = ['repoId', 'runId', 'attempt', 'rootJobId', 'heavyJobId', 'generation'];
export const JOB_STATUSES = Object.freeze(['queued', 'waiting', 'pending', 'requested', 'in_progress', 'completed']);
export const JOB_CONCLUSIONS = Object.freeze(['success', 'failure', 'cancelled', 'timed_out', 'action_required',
  'neutral', 'skipped', 'startup_failure', 'stale']);
const id = x => Number.isSafeInteger(x) && x > 0;
const count = x => Number.isSafeInteger(x) && x >= 0;
const clock = x => count(x) && x <= 8640000000000000;
const text = x => typeof x === 'string' && x.length > 0 && x.length <= 256 && !/[\u0000-\u001f\u007f]/u.test(x);
const sha = (x, n) => typeof x === 'string' && new RegExp(`^[a-f0-9]{${n}}$`).test(x);
const bool = x => typeof x === 'boolean';
const result = (status, reason) => ({ status, reason });
const unknown = () => result('Unknown', 'Evidence unknown');
const fresh = (stamp, now) => clock(stamp) && clock(now) && stamp <= now && now - stamp <= CANDIDATES.evidenceMs;

export function inputKey(x) {
  if (!x || !id(x.repoId) || !id(x.pr) || !sha(x.head, 40) || !sha(x.baseSha, 40) ||
      !sha(x.mergeSha, 40) || !sha(x.digest, 64) ||
      !['baseRef', 'workflow', 'workload', 'capability'].every(k => text(x[k]))) return null;
  return JSON.stringify(INPUT.map(k => x[k]));
}
export function executionKey(x) {
  if (!x || !['repoId', 'runId', 'attempt', 'rootJobId', 'generation'].every(k => id(x[k])) ||
      !(x.heavyJobId === null || (id(x.heavyJobId) && x.heavyJobId !== x.rootJobId))) return null;
  return JSON.stringify(EXECUTION.map(k => x[k]));
}
export function accountingDay(now) {
  if (!clock(now)) return null;
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: APPROVED.timezone,
    year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now);
  return ['year', 'month', 'day'].map(type => parts.find(p => p.type === type).value).join('-');
}
// Deliberately excludes PR/base/digest/capability/run/attempt/policy: no head-budget reset.
export function recoveryKey(input, now) {
  return inputKey(input) && accountingDay(now)
    ? JSON.stringify([input.repoId, input.workload, input.head, accountingDay(now)]) : null;
}
export function ownerRequestKey(x) {
  return x && ['repoId', 'runId', 'ownerAttempt', 'rootJobId'].every(k => id(x[k])) && x.ownerAttempt > 1
    ? JSON.stringify([x.repoId, x.runId, x.ownerAttempt, x.rootJobId]) : null;
}

// Envelope is an adapter assertion of COMPLETE pagination, not an API decoder.
// A validated empty list is Known-empty; callers must interpret absence per operation.
export function observeList(evidence, now, validate = () => true) {
  if (!evidence || evidence.complete !== true || !fresh(evidence.observedAt, now) ||
      !Array.isArray(evidence.items)) return unknown();
  const seen = new Set();
  for (const item of evidence.items) {
    if (!item || !id(item.id) || seen.has(item.id) || !validate(item)) return unknown();
    seen.add(item.id);
  }
  return { status: 'Known', items: evidence.items };
}
const sameInput = (a, b) => inputKey(a) !== null && inputKey(a) === inputKey(b);
const jobValid = j => ['repoId', 'runId', 'attempt'].every(k => id(j[k])) &&
  JOB_STATUSES.includes(j.status) && (j.status === 'completed' ? JOB_CONCLUSIONS.includes(j.conclusion) : j.conclusion === null) &&
  ['root', 'heavy', 'gate', 'other'].includes(j.role) && text(j.workload);

export function permitDecision(evidence, expected, now) {
  if (!expected || !inputKey(expected.input) || !executionKey(expected.execution) ||
      expected.input.repoId !== expected.execution.repoId || !id(expected.appId) || !id(expected.checkId) ||
      !clock(expected.launchIssuedAt) || !['launch', 'checkout'].includes(expected.phase)) return unknown();
  const observed = observeList(evidence, now);
  if (observed.status !== 'Known' || observed.items.length !== 1) return unknown();
  const p = observed.items[0];
  if (p.id !== expected.checkId || p.appId !== expected.appId || !sameInput(p.input, expected.input) ||
      executionKey(p.execution) !== executionKey(expected.execution) || p.phase !== expected.phase ||
      p.status !== 'completed' || p.conclusion !== 'success' || p.launchIssuedAt !== expected.launchIssuedAt ||
      !clock(p.issuedAt) || !clock(p.expiresAt) || p.issuedAt > now ||
      p.issuedAt < p.launchIssuedAt || p.expiresAt !== p.issuedAt + CANDIDATES.permitMs || now >= p.expiresAt) return unknown();
  if (p.phase === 'launch') {
    if (p.issuedAt !== p.launchIssuedAt || p.execution.heavyJobId !== null) return unknown();
  } else if (!id(p.execution.heavyJobId) || p.issuedAt >= p.launchIssuedAt + CANDIDATES.permitMs) return unknown();
  return result('Verified', 'Exact live permit');
}
export function reconciliationInterval(launchIssuedAt, now) {
  return clock(launchIssuedAt) && clock(now) && now >= launchIssuedAt &&
    now < launchIssuedAt + CANDIDATES.permitMs ? CANDIDATES.launchPollMs : CANDIDATES.ordinaryPollMs;
}

// Can also be reused as the terminal prerequisite for rerun planning. It never
// authorizes a rerun itself. Adapters must reconcile all pages of ALL attempts.
export function releaseDecision(reservation, evidence, now) {
  if (!reservation || !executionKey(reservation.execution) || !['none', 'confirmed'].includes(reservation.mutation)) return unknown();
  const x = reservation.execution;
  const observed = observeList(evidence, now, jobValid);
  const run = evidence?.run;
  if (observed.status !== 'Known' || !run || run.id !== x.runId || run.repoId !== x.repoId ||
      !id(run.attempt) || run.attempt < x.attempt || run.status !== 'completed' ||
      !Array.isArray(evidence.coveredAttempts) || evidence.coveredAttempts.length !== run.attempt ||
      !evidence.coveredAttempts.every((n, i) => n === i + 1) ||
      observed.items.some(j => j.repoId !== x.repoId || j.runId !== x.runId || j.attempt > run.attempt || j.status !== 'completed')) return unknown();
  const required = [x.rootJobId, x.heavyJobId].filter(n => n !== null);
  if (!required.every(n => observed.items.some(j => j.id === n && j.attempt === x.attempt))) return unknown();
  return result('Release', 'Exact graph terminal');
}

// Roles/workloads must come from the reviewed workflow closure, never job-name
// guessing. This returns request identities, not durable claims or latch edits.
export function ownerRequests(observation, expected, now) {
  if (!observation || !expected || !inputKey(expected.input) || !Array.isArray(expected.rootInputs) ||
      !expected.rootInputs.length || !expected.rootInputs.every(root => inputKey(root) &&
        INPUT.filter(k => !['workload', 'capability'].includes(k)).every(k => root[k] === expected.input[k])) ||
      !expected.rootInputs.some(root => sameInput(root, expected.input)) ||
      new Set(expected.rootInputs.map(root => root.workload)).size !== expected.rootInputs.length) return unknown();
  const { attempt: a, jobs, refs, permission: p } = observation;
  if (!a || !['repoId', 'runId', 'number', 'triggeringActorId'].every(k => id(a[k])) ||
      !['User', 'Bot'].includes(a.triggeringActorType) || !fresh(a.observedAt, now) || !sameInput(a.input, expected.input) ||
      a.repoId !== expected.input.repoId || !refs || !fresh(refs.observedAt, now) || !sameInput(refs.input, expected.input)) return unknown();
  const observed = observeList(jobs, now, jobValid);
  if (observed.status !== 'Known' || observed.items.some(j => j.repoId !== a.repoId || j.runId !== a.runId || j.attempt !== a.number)) return unknown();
  if (a.number === 1 || a.triggeringActorId !== APPROVED.ownerId || a.triggeringActorType !== 'User') return { status: 'Known', items: [] };
  if (!p || p.actorId !== APPROVED.ownerId || !fresh(p.observedAt, now) || !['write', 'admin'].includes(p.value)) return unknown();
  const roots = observed.items.filter(j => j.role === 'root');
  if (new Set(roots.map(j => j.workload)).size !== roots.length ||
      roots.some(j => !expected.rootInputs.some(root => root.workload === j.workload))) return unknown();
  return { status: 'Known', items: roots.map(j => ({ repoId: a.repoId, runId: a.runId,
    ownerAttempt: a.number, rootJobId: j.id, workload: j.workload,
    input: { ...expected.rootInputs.find(root => root.workload === j.workload) } })) };
}

// Durable records supplying these counters/latches must use inputKey/recoveryKey
// and ownerRequestKey; a run, policy update or later Held cannot replace them.
export function recoveryDecision(record, now) {
  const r = record;
  if (!r || !inputKey(r.input) || !clock(now) || !clock(r.readyAt) || r.readyAt > now ||
      !clock(r.intentCreatedAt) || r.intentCreatedAt < r.readyAt || r.intentCreatedAt > now ||
      !(r.lastRecoveryAt === null || (clock(r.lastRecoveryAt) && r.lastRecoveryAt <= now)) ||
      !count(r.dailyRecoveries) || !count(r.requestReentries) || !bool(r.success) || !bool(r.failureLatched)) return unknown();
  const request = r.ownerRequest;
  if (request !== null && (!ownerRequestKey(request) || !sameInput(request.input, r.input) ||
      request.repoId !== r.input.repoId || request.workload !== r.input.workload)) return unknown();
  if (now - r.intentCreatedAt >= CANDIDATES.waitingMs) return result('Held', 'Waiting intent expired');
  if (r.dailyRecoveries >= CANDIDATES.recoveriesDay || (request && r.requestReentries >= CANDIDATES.reentriesRequest)) return result('Held', 'Recovery bound reached');
  if (r.lastRecoveryAt !== null && now - r.lastRecoveryAt < CANDIDATES.cooldownMs) return result('Held', 'Recovery cooldown');
  if (!request && r.failureLatched) return result('Held', 'Genuine or ambiguous failure latched');
  if (!request && r.success) return result('Held', 'Successful inputs retained');
  return result('Eligible', 'Recovery predicates satisfied');
}

// Add-only: scoped owner authorization belongs to a separate durable transition.
// A later held attempt/success or a new run/policy cannot clear an existing latch.
export function failureLatch(previous, evidence) {
  if (!bool(previous) || !evidence || !['before_checkout', 'after_checkout', 'unknown'].includes(evidence.checkpoint) ||
      !['held', 'success', 'failure', 'unknown'].includes(evidence.outcome)) return null;
  return previous || (evidence.checkpoint !== 'before_checkout' && evidence.outcome !== 'success') ||
    (evidence.checkpoint === 'unknown' && evidence.outcome === 'success');
}

// Safety predicate only: capacity, enrollment, current refs, native terminal
// evidence, durable intent/fencing and owner-request rechecks are ALSO required.
export function newWorkDecision(state, now) {
  if (!state || !clock(now)) return unknown();
  const { activation: a, rate: r, accounting: b } = state;
  if (!a || !text(a.id) || a.ownerAuthorized !== true || !clock(a.startedAt) || !clock(a.expiresAt) ||
      a.expiresAt - a.startedAt !== APPROVED.pilotMs || !bool(state.paused) || !bool(state.revoked) ||
      !(state.backoffUntil === null || clock(state.backoffUntil)) || !r ||
      r.complete !== true || !fresh(r.observedAt, now) ||
      !['readsHour', 'writesHour', 'writesMinute'].every(k => count(r[k])) ||
      typeof r.headroom !== 'number' || !Number.isFinite(r.headroom) || r.headroom < 0 || r.headroom > 1 ||
      !b || b.status !== 'Known' || b.complete !== true || !fresh(b.observedAt, now) ||
      !['hostedMinutesDay', 'hostedMinutesTotal', 'unexpectedHostedJobs', 'hostedReservations'].every(k => count(b[k])) ||
      b.hostedMinutesDay > b.hostedMinutesTotal || !bool(b.zeroHostedClosure)) return unknown();
  if (state.paused || state.revoked || now < a.startedAt || now >= a.expiresAt) return result('Held', 'Pilot inactive');
  if ((state.backoffUntil !== null && now < state.backoffUntil) || r.readsHour >= CANDIDATES.readsHour ||
      r.writesHour >= CANDIDATES.writesHour || r.writesMinute >= CANDIDATES.writesMinute || r.headroom < CANDIDATES.headroom) return result('Held', 'Rate or backoff bound');
  if (!b.zeroHostedClosure || b.hostedReservations || b.unexpectedHostedJobs || b.hostedMinutesDay || b.hostedMinutesTotal) return result('Held', 'Self-hosted accounting fault');
  return result('Eligible', 'Safety predicates satisfied');
}
