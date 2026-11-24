// Disabled durable protocol, called only inside ShadowController's SAME SQLite
// transaction/state row. No HTTP, credential, dispatcher, timer, route or switch.
import { createHash } from 'node:crypto';
import { APPROVED, CANDIDATES, inputKey, executionKey, newWorkDecision, releaseDecision,
  observeList, permitDecision, recoveryKey, ownerRequests, ownerRequestKey } from './ci-admission.mjs';
import { validEnrollment } from './ci-admission-native.mjs';
const ensure = b => { if (!b) throw new Error('Unknown writer evidence or state'); };
const id = n => Number.isSafeInteger(n) && n > 0;
const clock = n => Number.isSafeInteger(n) && n >= 0 && n <= 8640000000000000;
const copy = x => JSON.parse(JSON.stringify(x));
const stable = x => JSON.stringify(x, (_, v) => v && typeof v === 'object' && !Array.isArray(v)
  ? Object.fromEntries(Object.keys(v).sort().map(k => [k, v[k]])) : v);
export const commandDigest = c => createHash('sha256').update(stable(c)).digest('hex');
const REPOS = Object.freeze({ 1318535693: 'crossroads-hq/crossroads-evolution', 1305651079: 'crossroads-hq/crossroads-ui' });
const empty = () => ({ version: 1, mode: 'DISABLED', stopped: false, epoch: 1, writes: [] });
export const ACTIVATION_BLOCKERS = Object.freeze(['AI_HEAVY_TOKEN_SCOPE', 'CROSS_DATE_BILLING',
  'CHECKOUT_REMOTE_PUBLICATION_DEADLINE_UNPROVEN']);
export const writerState = s => s.writer ?? empty();
export function validateWriter(s) {
  ensure(s && Array.isArray(s.obligations));
  if (!s.writer) {
    ensure(!s.obligations.some(o => o.writerManaged));
    return; // Explicit additive v1 upgrade; never discard existing writer state.
  }
  const w = s.writer;
  ensure(w.version === 1 && w.mode === 'DISABLED' && typeof w.stopped === 'boolean' && id(w.epoch) &&
    Array.isArray(w.writes) && w.writes.length <= 2048 && w.writes.every((r, n) => r.id === n + 1 &&
      id(r.generation) && s.obligations.some(o => o.generation === r.generation && o.writerManaged === true) &&
      inputKey(r.input) && executionKey(r.execution) && clock(r.preparedAt) && id(r.epoch) &&
      ['rerun', 'create', 'publish'].includes(r.kind) && ['intent', 'unresolved', 'confirmed', 'fenced'].includes(r.state) &&
      (r.checkId === null || id(r.checkId)) && r.request?.origin === 'https://api.github.com' &&
      ['POST', 'PATCH'].includes(r.request.method) && typeof r.request.path === 'string'));
  for (const r of w.writes) {
    const o = s.obligations.find(o => o.generation === r.generation);
    const expectedExecution = r.kind === 'rerun' ? o.origin :
      { ...o.execution, heavyJobId: r.phase === 'launch' ? null : o.execution.heavyJobId };
    ensure(inputKey(o.input) === o.key && id(o.appId) && o.appId !== APPROVED.gateAppId &&
      inputKey(r.input) === o.key && executionKey(r.execution) === executionKey(expectedExecution) &&
      r.preparedAt >= o.reservedAt && r.preparedAt <= s.lastAt && r.epoch <= w.epoch &&
      (r.kind === 'rerun' ? r.phase === null && r.checkId === null : ['launch', 'checkout'].includes(r.phase)) &&
      (r.kind !== 'publish' || id(r.checkId)) &&
      (r.kind !== 'create' || r.state !== 'confirmed' || id(r.checkId)) && stable(r.request) === stable(requestFor(o, r)));
    if (r.state === 'intent' || r.state === 'fenced') ensure(r.fencedAt === null && r.confirmedAt === null);
    else ensure(clock(r.fencedAt) && r.fencedAt >= r.preparedAt && r.fencedAt <= s.lastAt &&
      (r.state === 'unresolved' ? r.confirmedAt === null : clock(r.confirmedAt) &&
        r.confirmedAt >= r.fencedAt && r.confirmedAt <= s.lastAt));
  }
}
function rate(s, f, now) {
  // Count every durable intended write conservatively, including lost receipts.
  // Supplied counters MUST cover all App consumers, pages and reconciliation reads.
  // All current-window writes may be double counted; intents never disappear
  // behind a newer observation. This sacrifices throughput for bounded safety.
  const safety = copy(f.safety), r = safety.rate;
  ensure(r && clock(r.observedAt));
  const pending = writerState(s).writes.filter(w => w.state === 'intent' ||
    (w.fencedAt !== null && now - w.fencedAt < 3600000));
  r.writesHour += pending.filter(w => w.state === 'intent' || now - w.fencedAt < 3600000).length + 1;
  r.writesMinute += pending.filter(w => w.state === 'intent' || now - w.fencedAt < 60000).length + 1;
  ensure(newWorkDecision(safety, now).status === 'Eligible');
}
function guard(s, o, c, h) {
  const { now, frame: f } = c;
  ensure(!writerState(s).stopped && f && o && !o.released && o.writerManaged);
  const p = h.prerequisites(s, f, now);
  ensure(!p.reason && o.activationId === f.safety.activation.id && h.current(h.record(s, o.key), f, p.g) &&
    h.ownerCurrent(s, h.record(s, o.key), f, now) !== false && o.appId === f.schedulerAppId &&
    o.appId !== APPROVED.gateAppId && h.active(s).every(q => h.capacity(s, f.capacity, now, q.input.repoId) >= 0));
  const enrolled = observeList({ ...f.enrollments, items: f.enrollments?.items?.map((e, n) => ({ ...e, id: n + 1 })) }, now, validEnrollment);
  ensure(enrolled.status === 'Known' && Array.isArray(f.enrollments.repoIds) &&
    f.enrollments.repoIds.length === 2 && APPROVED.repoIds.every(n => f.enrollments.repoIds.includes(n)));
  const matches = enrolled.items.filter(e => e.repoId === o.input.repoId && e.workload === o.input.workload);
  ensure(matches.length === 1);
  const e = matches[0];
  ensure(e.repository === REPOS[o.input.repoId] && e.schedulerAppId === o.appId &&
    e.workflow === o.input.workflow && e.digest === o.input.digest && e.capability === o.input.capability &&
    e.workload !== 'AI'); // Story 7 heavy-token conflict remains an activation blocker.
  const gates = observeList(f.gates, now, g => APPROVED.repoIds.includes(g.id) && g.appId === APPROVED.gateAppId);
  ensure(gates.status === 'Known' && gates.items.length === 2 && APPROVED.repoIds.every(n => gates.items.some(g => g.id === n)));
  rate(s, f, now);
}
function append(s, o, kind, phase, now, checkId = null) {
  const w = s.writer;
  ensure(w.writes.length < 2048);
  const value = { id: w.writes.length + 1, generation: o.generation, input: copy(o.input),
    execution: copy(o.execution), kind, phase, state: 'intent', epoch: w.epoch,
    preparedAt: now, fencedAt: null, confirmedAt: null, checkId,
    request: null };
  value.request = requestFor(o, value);
  w.writes.push(value); return value;
}
const base = o => `/repos/${REPOS[o.input.repoId]}`;
const name = (o, phase) => `CI admission ${phase} / ${o.input.workload}`;
const external = (o, phase) => `hq-085/v1/${o.generation}/${phase}`;
function requestFor(o, r) {
  let method, path, body;
  if (r.kind === 'rerun') {
    method = 'POST'; path = `${base(o)}/actions/jobs/${o.origin.rootJobId}/rerun`;
    body = { enable_debug_logging: false };
  } else if (r.kind === 'create') {
    method = 'POST'; path = `${base(o)}/check-runs`;
    body = { name: `CI admission pending / ${r.phase} / ${o.input.workload}`,
      head_sha: o.input.mergeSha, external_id: external(o, r.phase), status: 'in_progress',
      output: { title: 'Admission held', summary: 'Pending durable reconciliation' } };
  } else {
    method = 'PATCH'; path = `${base(o)}/check-runs/${r.checkId}`;
    const value = { id: r.checkId, appId: o.appId, input: o.input, execution: r.execution,
      phase: r.phase, status: 'completed', conclusion: 'success',
      launchIssuedAt: r.phase === 'launch' ? r.preparedAt : o.launch?.issuedAt,
      issuedAt: r.preparedAt, expiresAt: r.preparedAt + CANDIDATES.permitMs };
    ensure(permitDecision({ complete: true, observedAt: r.preparedAt, items: [value] }, {
      input: o.input, execution: r.execution, appId: o.appId, checkId: r.checkId,
      phase: r.phase, launchIssuedAt: value.launchIssuedAt }, r.preparedAt).status === 'Verified');
    body = { name: name(o, r.phase), external_id: external(o, r.phase), status: 'completed', conclusion: 'success',
      output: { title: 'CI admission permit', summary: 'Exact fenced execution',
        text: JSON.stringify({ protocol: 'hq-085-permit-v1', ...value }) } };
  }
  return { origin: 'https://api.github.com', method, path, body };
}
export function writerAudit(s, before, c) {
  const w = writerState(s), prior = writerState(before);
  const changed = w.writes.filter(r => stable(r) !== stable(prior.writes.find(p => p.id === r.id)));
  const generations = new Set(changed.map(r => r.generation));
  if (id(c.generation)) generations.add(c.generation);
  for (const o of s.obligations) if (o.writerManaged &&
    stable(o) !== stable(before.obligations.find(p => p.generation === o.generation))) generations.add(o.generation);
  const targets = s.obligations.filter(o => generations.has(o.generation));
  const first = targets[0], f = c.frame;
  const source = e => e ? { observedAt: clock(e.observedAt) ? e.observedAt : null, complete: e.complete === true } : null;
  const rate = f?.safety?.rate;
  const safetyValidated = newWorkDecision(f?.safety, c.now).status !== 'Unknown';
  const ownerKeys = new Set(targets.map(o => o.ownerKey).filter(Boolean));
  const owners = ownerKeys.size && f ? f.ownerChecks : [];
  ensure(Array.isArray(owners) && owners.length <= 512);
  const ownerEvidence = owners.filter(check => {
    ensure(check?.expected?.rootInputs?.length <= 32 && check?.observation?.jobs?.items?.length <= 2048);
    const requests = ownerRequests(check.observation, check.expected, c.now);
    ensure(requests.status === 'Known');
    return requests.items.some(q => ownerKeys.has(ownerRequestKey(q)));
  });
  return { mode: 'DISABLED', stopped: w.stopped, epoch: w.epoch,
    appId: first?.appId ?? null, writes: copy(changed), targets: copy(targets),
    ownerChecks: ownerEvidence.map(check => ({
      inputKey: inputKey(check.expected?.input),
      attempt: check.observation?.attempt ? { repoId: check.observation.attempt.repoId,
        runId: check.observation.attempt.runId, number: check.observation.attempt.number,
        triggeringActorId: check.observation.attempt.triggeringActorId,
        triggeringActorType: check.observation.attempt.triggeringActorType,
        observedAt: check.observation.attempt.observedAt } : null,
      jobs: source(check.observation?.jobs), refs: check.observation?.refs ? {
        inputKey: inputKey(check.observation.refs.input), observedAt: check.observation.refs.observedAt } : null,
      permission: check.observation?.permission ? { actorId: check.observation.permission.actorId,
        value: check.observation.permission.value, observedAt: check.observation.permission.observedAt } : null })),
    sources: { inputs: source(f?.inputs), prs: source(f?.prs), capacity: source(f?.capacity),
      enrollments: source(f?.enrollments), gates: source(f?.gates), rate: source(rate),
      accounting: source(f?.safety?.accounting), checks: source(c.checks), jobs: source(c.jobs) },
    bounds: safetyValidated ? { readsHourRemaining: Math.max(0, CANDIDATES.readsHour - rate.readsHour),
      writesHourRemaining: Math.max(0, CANDIDATES.writesHour - rate.writesHour - w.writes.filter(r =>
        r.state === 'intent' || (r.fencedAt !== null && c.now - r.fencedAt < 3600000)).length),
      writesMinuteRemaining: Math.max(0, CANDIDATES.writesMinute - rate.writesMinute - w.writes.filter(r =>
        r.state === 'intent' || (r.fencedAt !== null && c.now - r.fencedAt < 60000)).length),
      headroom: rate.headroom, recoveriesDayRemaining: first ? CANDIDATES.recoveriesDay -
        (s.daily[recoveryKey(first.input, c.now)] || 0) : null,
      requestReentriesRemaining: first?.ownerKey ? CANDIDATES.reentriesRequest -
        s.requests.find(q => q.key === first.ownerKey).reentries : null,
      activationExpiresAt: f.safety.activation.expiresAt,
      hostedMinutesDay: f.safety.accounting.hostedMinutesDay,
      hostedMinutesTotal: f.safety.accounting.hostedMinutesTotal } : null };
}
function checkList(c, o, phase, now) {
  ensure(c && inputKey(c.input) === o.key && executionKey(c.execution) === executionKey(o.execution) && c.phase === phase);
  const value = observeList(c, now, p => id(p.app?.id) && typeof p.name === 'string' && typeof p.head_sha === 'string');
  ensure(value.status === 'Known' && value.items.length <= 1); return value.items;
}
function exactCheck(check, row, o) {
  const b = row.request.body;
  return check.id === (row.kind === 'create' ? check.id : row.checkId) &&
    check.app.id === o.appId && check.head_sha === o.input.mergeSha && check.name === b.name &&
    check.external_id === b.external_id && check.status === b.status && check.conclusion === (b.conclusion ?? null) &&
    stable(check.output) === stable(b.output);
}
export function writerTransition(s, c, h) {
  s.writer ??= empty(); const w = s.writer, now = c.now;
  const obligation = generation => h.byGeneration(s, generation);
  const get = () => { const r = w.writes.find(r => r.id === c.writeId); ensure(r); return r; };
  switch (c.type) {
    case 'writer-reserve': {
      ensure(!w.stopped);
      // choose() is the ONE policy owner. Its entire multi-repo selection, budget
      // charges, fairness and intents roll back if any writer guard fails.
      const result = h.choose(s, c.frame, now);
      for (const q of result.selected) {
        const o = obligation(q.generation); o.writerManaged = true; guard(s, o, c, h);
        if (o.mutation === 'intent') append(s, o, 'rerun', null, now);
      }
      return result;
    }
    case 'writer-prepare': {
      const o = obligation(c.generation); guard(s, o, c, h);
      ensure(['none', 'confirmed'].includes(o.mutation) && ['launch', 'checkout'].includes(c.phase));
      const rows = w.writes.filter(r => r.generation === o.generation && r.phase === c.phase);
      const created = rows.find(r => r.kind === 'create');
      ensure(!rows.some(r => r.kind === 'publish') &&
        (!created || (created.state === 'confirmed' && id(created.checkId))));
      // Reuse the canonical permit transition on a disposable state to validate
      // capacity/owner/phase/expiry and construct the ONE canonical wire value.
      const checkId = created ? created.checkId : Number.MAX_SAFE_INTEGER;
      const trial = copy(s);
      h.permit(trial, { ...c, appId: o.appId, checkId }, now);
      if (!created) {
        ensure(checkList(c.checks, o, c.phase, now).length === 0);
        append(s, o, 'create', c.phase, now);
      } else append(s, o, 'publish', c.phase, now, checkId);
      return h.answer('Recorded', 'Disabled write intent persisted');
    }
    case 'writer-fence': {
      const r = get(), o = obligation(r.generation); guard(s, o, c, h);
      ensure(r.state === 'intent' && r.epoch === w.epoch && now - r.preparedAt <= CANDIDATES.launchPollMs);
      if (r.kind === 'rerun') ensure(c.frame.terminal.some(e =>
        e.run.attempt + 1 === o.expectedAttempt && releaseDecision({ execution: o.origin, mutation: 'none' }, e, now).status === 'Release'));
      else {
        ensure(executionKey(r.execution) === executionKey(o.execution));
        const trial = copy(s); h.permit(trial, { generation: o.generation, phase: r.phase, appId: o.appId,
          checkId: r.kind === 'create' ? Number.MAX_SAFE_INTEGER : r.checkId, frame: c.frame }, now);
      }
      // A later executor MUST commit this before network, at most once. No
      // descriptor/effect is returned, even on idempotent command receipt replay.
      r.state = 'unresolved'; r.fencedAt = now;
      if (r.kind === 'rerun') { o.mutation = 'unresolved'; o.phase = 'Unknown'; }
      return h.answer('Recorded', 'Disabled write fenced; reconciliation required');
    }
    case 'writer-bind': {
      const r = get(), o = obligation(r.generation);
      ensure(r.kind === 'rerun' && r.state === 'unresolved' && c.appId === o.appId && inputKey(c.input) === o.key);
      h.bind(s, { ...c, generation: o.generation }, now);
      r.state = 'confirmed'; r.confirmedAt = now;
      return h.answer('Recorded', 'Simulated exact App attempt reconciled');
    }
    case 'writer-bind-heavy': {
      const o = obligation(c.generation); ensure(o.writerManaged && o.launch &&
        !w.writes.some(r => r.generation === o.generation && ['intent', 'unresolved'].includes(r.state)));
      return h.bind(s, c, now);
    }
    case 'writer-reconcile': {
      const r = get(), o = obligation(r.generation); ensure(r.kind !== 'rerun' && r.state === 'unresolved');
      const values = checkList(c.checks, { ...o, execution: r.execution }, r.phase, now);
      ensure(values.length === 1 && exactCheck(values[0], r, o)); const check = values[0];
      if (r.kind === 'publish' && r.phase === 'checkout') ensure(o.launch && now < o.launch.expiresAt);
      // This conservative local refusal is NOT a proof that a remote late PATCH
      // was invisible to pinned readers. ACTIVATION_BLOCKERS retains that gap.
      if (r.kind === 'create') {
        ensure(!s.obligations.some(q => [q.launch?.id, q.checkout?.id].includes(check.id)) &&
          !w.writes.some(q => q.id !== r.id && q.kind === 'create' && q.checkId === check.id && q.input.repoId === r.input.repoId));
        r.checkId = check.id;
      } else {
        const value = JSON.parse(r.request.body.output.text);
        ensure(permitDecision({ complete: true, observedAt: value.issuedAt, items: [value] }, {
          input: o.input, execution: r.execution, appId: o.appId, checkId: r.checkId,
          phase: r.phase, launchIssuedAt: value.launchIssuedAt }, value.issuedAt).status === 'Verified');
        ensure(!o[r.phase]); o[r.phase] = value;
        if (r.phase === 'checkout' && !w.stopped && now < value.expiresAt) o.phase = 'Bound';
        else if (w.stopped || now >= value.expiresAt) o.phase = 'Held';
      }
      r.state = 'confirmed'; r.confirmedAt = now;
      return h.answer('Recorded', 'Exact simulated write reconciled; clocks retained');
    }
    case 'writer-stop':
      w.stopped = true; w.epoch++;
      for (const r of w.writes) if (r.state === 'intent') {
        if (r.kind === 'rerun') {
          const o = obligation(r.generation);
          ensure(o.mutation === 'intent' && executionKey(o.execution) === executionKey(o.origin));
          // No dispatch fence was committed: this is known no-mutation, not a
          // lost outcome. Retain the journal/charges and require terminal drain.
          o.mutation = 'none';
        }
        r.state = 'fenced';
      }
      for (const o of h.active(s)) if (o.writerManaged && o.phase !== 'Active') o.phase = 'Held';
      return h.answer('Recorded', 'Writer stopped; obligations and short rights retained');
    default: throw new Error('Unknown writer command');
  }
}
