// Source-only shadow model. There is deliberately no network, Worker entry point,
// alarm, credential, activation switch, or effect executor in this module.
import { APPROVED, CANDIDATES, inputKey, executionKey, recoveryKey, ownerRequestKey,
  ownerRequests, releaseDecision, recoveryDecision, failureLatch, newWorkDecision,
  permitDecision, accountingDay, reconciliationInterval, JOB_STATUSES, JOB_CONCLUSIONS } from './ci-admission.mjs';

import { writerTransition, writerState, validateWriter, commandDigest, writerAudit } from './ci-admission-writer.mjs';

const VERSION = 1;
const MAX_RECORDS = 512, MAX_LEDGER = 2048, MAX_COMMANDS = 10000;
const id = n => Number.isSafeInteger(n) && n > 0;
const clock = n => Number.isSafeInteger(n) && n >= 0 && n <= 8640000000000000;
const fresh = (at, now) => clock(at) && at <= now && now - at <= CANDIDATES.evidenceMs;
const tag = s => typeof s === 'string' && /^[a-zA-Z0-9_.\/-]{1,64}$/u.test(s);
// Literal branch names, not command tags or checkout shorthand. Match Git's
// branch-ref rules without normalization: https://git-scm.com/docs/git-check-ref-format
const branchRef = s => typeof s === 'string' && s.length > 0 && s !== 'HEAD' && !s.startsWith('-') &&
  !/[\u0000-\u0020\u007f~^:?*\[\\]/u.test(s) && !s.includes('..') && !s.includes('@{') && !s.endsWith('.') &&
  s.split('/').every(part => part.length > 0 && !part.startsWith('.') && !part.endsWith('.lock'));
const clone = x => JSON.parse(JSON.stringify(x));
const ensure = b => { if (!b) throw new Error('Unknown shadow evidence or state'); };
const answer = (status, reason, selected = []) => ({ status, reason, selected, effects: [] });
const scope = x => Array.isArray(x) && x.length === APPROVED.repoIds.length &&
  new Set(x).size === x.length && APPROVED.repoIds.every(n => x.includes(n));
const identity = x => { ensure(inputKey(x) && APPROVED.repoIds.includes(x.repoId));
  const names = ['repoId', 'pr', 'head', 'baseRef', 'baseSha', 'mergeSha', 'workflow', 'digest', 'workload', 'capability'];
  return Object.fromEntries(names.map((k, n) => [k, JSON.parse(inputKey(x))[n]])); };
const execution = x => { ensure(executionKey(x)); return Object.fromEntries(
  ['repoId', 'runId', 'attempt', 'rootJobId', 'heavyJobId', 'generation'].map((k, n) => [k, JSON.parse(executionKey(x))[n]])); };
const sameRun = (a, b) => a.repoId === b.repoId && a.runId === b.runId;
const headKey = i => JSON.stringify([i.repoId, i.workload, i.head]);
const initialAuthority = (s, r) => r.mode === 'initial' && s.obligations.some(o => o.execution.repoId === r.input.repoId &&
  [o.execution.rootJobId, o.execution.heavyJobId].filter(id).some(n => [r.execution.rootJobId, r.execution.heavyJobId].includes(n)));
const prKey = i => `${i.repoId}/${i.pr}`;
const active = s => s.obligations.filter(o => !o.released);
const byGeneration = (s, generation) => { const o = s.obligations.find(o => o.generation === generation);
  ensure(o && !o.released); return o; };
const record = (s, key) => { const r = s.inputs.find(r => r.key === key); ensure(r); return r; };
const closedJob = j => j && ['id', 'repoId', 'runId', 'attempt'].every(k => id(j[k])) &&
  JOB_STATUSES.includes(j.status) && (j.status === 'completed' ? JOB_CONCLUSIONS.includes(j.conclusion) : j.conclusion === null) &&
  ['root', 'heavy', 'gate', 'other'].includes(j.role) && typeof j.workload === 'string';
function complete(e, now, valid, key = x => x.id) {
  return e?.complete === true && fresh(e.observedAt, now) && Array.isArray(e.items) &&
    e.items.length <= MAX_LEDGER && e.items.every(valid) && new Set(e.items.map(key)).size === e.items.length;
}
function initial() {
  return { version: VERSION, revision: 0, lastAt: 0, generation: 0, cursor: null,
    inputs: [], obligations: [], requests: [], daily: {}, lastRecovery: {}, ledger: [], lastDecision: null };
}
function validateState(s) {
  validateWriter(s);
  ensure(s?.version === VERSION && clock(s.lastAt) && clock(s.revision) && clock(s.generation) &&
    ['inputs', 'obligations', 'requests', 'ledger'].every(k => Array.isArray(s[k])) &&
    s.inputs.length <= MAX_RECORDS && s.obligations.length <= MAX_RECORDS && s.requests.length <= MAX_RECORDS &&
    s.ledger.length <= MAX_LEDGER && s.daily && s.lastRecovery &&
    Object.values(s.daily).every(clock) && Object.values(s.lastRecovery).every(at => clock(at) && at <= s.lastAt));
  ensure(s.inputs.every(r => r.key === inputKey(r.input) && executionKey(r.execution) &&
    typeof r.success === 'boolean' && typeof r.failureLatched === 'boolean' && clock(r.readyAt) && clock(r.intentCreatedAt) &&
    typeof r.pending === 'boolean' && typeof r.mandatory === 'boolean' && ['initial', 'recovery'].includes(r.mode)));
  ensure(s.requests.every(q => q.key === ownerRequestKey(q.request) && inputKey(q.request.input) &&
    clock(q.reentries) && typeof q.fulfilled === 'boolean' && clock(q.intentCreatedAt)));
  ensure(s.obligations.every(o => id(o.generation) && o.generation <= s.generation &&
    s.inputs.some(r => r.key === o.key) && executionKey(o.execution) && o.execution.generation === o.generation &&
    ['none', 'intent', 'unresolved', 'confirmed'].includes(o.mutation) && typeof o.released === 'boolean'));
  ensure(new Set(s.obligations.map(o => o.generation)).size === s.obligations.length);
}

// All open PRs in both repositories, not just ready candidates. Missing coverage
// holds the graph; branch strings are identity data and never used as file paths.
function graph(e, now) {
  ensure(scope(e?.repoIds) && complete(e, now, n => id(n.id) && id(n.pr) && APPROVED.repoIds.includes(n.repoId) &&
    branchRef(n.headRef) && branchRef(n.baseRef) && typeof n.open === 'boolean' && typeof n.draft === 'boolean' && n.refsKnown === true));
  const nodes = e.items.filter(n => n.open), map = new Map(nodes.map(n => [prKey(n), n]));
  ensure(map.size === nodes.length);
  const parents = new Map(), roots = new Map(), ancestors = new Map();
  for (const n of nodes) {
    const matches = nodes.filter(p => p.repoId === n.repoId && p.headRef === n.baseRef);
    ensure(matches.length <= 1); parents.set(prKey(n), matches.length ? prKey(matches[0]) : null);
  }
  for (const n of nodes) {
    const seen = new Set([prKey(n)]); let p = prKey(n);
    while (parents.get(p) !== null) { p = parents.get(p); ensure(p && !seen.has(p)); seen.add(p); }
    roots.set(prKey(n), p); seen.delete(prKey(n)); ancestors.set(prKey(n), seen);
  }
  return { map, roots, ancestors };
}

// Conservative worst placement: every eligible physical group must have room
// for ALL managed reservations. No future GitHub dispatch order/group is assumed.
// This may hold usable capacity; it cannot invent independent WSL machines.
function capacity(s, c, now, repoId) {
  ensure(c?.complete === true && fresh(c.observedAt, now) && Array.isArray(c.groups) && c.groups.length > 0 &&
    c.groups.length <= MAX_RECORDS && c.groups.every(g => id(g.id) && id(g.slots)) && new Set(c.groups.map(g => g.id)).size === c.groups.length &&
    Array.isArray(c.runners) && c.runners.length <= MAX_RECORDS && c.runners.every(r => id(r.id) &&
      c.groups.some(g => g.id === r.groupId) && Array.isArray(r.repoIds) && r.repoIds.length > 0 &&
      new Set(r.repoIds).size === r.repoIds.length && r.repoIds.every(id) && Array.isArray(r.labels) &&
      r.labels.every(tag) && typeof r.online === 'boolean') && new Set(c.runners.map(r => r.id)).size === c.runners.length &&
    Array.isArray(c.jobs) && c.jobs.length <= MAX_LEDGER && c.jobs.every(j => id(j.id) && id(j.runnerId) &&
      c.runners.some(r => r.id === j.runnerId) && (j.generation === null || id(j.generation))) &&
    new Set(c.jobs.map(j => j.id)).size === c.jobs.length && new Set(c.jobs.map(j => j.runnerId)).size === c.jobs.length);
  const reservations = active(s);
  for (const j of c.jobs.filter(j => j.generation !== null)) {
    const o = reservations.find(o => o.generation === j.generation);
    ensure(o && [o.execution.rootJobId, o.execution.heavyJobId].includes(j.id));
  }
  const runners = c.runners.filter(r => r.online && r.labels.includes('fast') && r.repoIds.includes(repoId));
  const groups = c.groups.filter(g => runners.some(r => r.groupId === g.id));
  if (!groups.length) return -1;
  const room = groups.map(g => {
    const unmanaged = c.jobs.filter(j => j.generation === null && c.runners.find(r => r.id === j.runnerId).groupId === g.id).length;
    return Math.min(g.slots, runners.filter(r => r.groupId === g.id).length) - unmanaged - reservations.length;
  });
  // Zero means fully reserved but feasible; negative means retained obligations
  // no longer fit. Publication must distinguish these two states.
  return Math.min(CANDIDATES.managedFast - reservations.length, ...room);
}
function accounting(s) {
  const unknown = !s.ledger.length || s.ledger.some(j => j.roundedMinutes === null || j.day === null || j.runnerType === 'unknown');
  return { status: unknown || !s.ledger.length ? 'Unknown' : 'Known',
    unexpectedHostedJobs: s.ledger.filter(j => j.runnerType === 'hosted').length,
    hostedMinutesTotal: unknown ? null : s.ledger.filter(j => j.runnerType === 'hosted').reduce((n, j) => n + j.roundedMinutes, 0),
    days: unknown ? null : Object.fromEntries([...new Set(s.ledger.map(j => j.day))].map(day => [day,
      s.ledger.filter(j => j.day === day && j.runnerType === 'hosted').reduce((n, j) => n + j.roundedMinutes, 0)])),
    crossDatePolicy: 'UNRESOLVED_ACTIVATION_BLOCKER' };
}
function prerequisites(s, f, now) {
  ensure(f && id(f.schedulerAppId) && scope(f.inputs?.repoIds) && complete(f.inputs, now, i => inputKey(i) && APPROVED.repoIds.includes(i.repoId), inputKey));
  ensure(Array.isArray(f.terminal) && f.terminal.length <= MAX_RECORDS &&
    f.terminal.every(e => e && id(e.run?.repoId) && id(e.run?.id)) &&
    new Set(f.terminal.map(e => `${e.run.repoId}/${e.run.id}`)).size === f.terminal.length);
  ensure(new Set(f.inputs.items.map(i => JSON.stringify([i.repoId, i.pr, i.workload]))).size === f.inputs.items.length);
  const g = graph(f.prs, now);
  for (const repoId of APPROVED.repoIds) capacity(s, f.capacity, now, repoId);
  const safety = newWorkDecision(f.safety, now);
  ensure(safety.status !== 'Unknown');
  if (safety.status !== 'Eligible') return { g, reason: safety.reason };
  if (s.ledger.some(j => j.runnerType !== 'self-hosted' || j.roundedMinutes !== 0 || j.day === null)) return { g, reason: 'Accounting fault' };
  return { g, reason: null };
}
function current(r, f, g) {
  const n = g.map.get(prKey(r.input));
  return n && !n.draft && n.baseRef === r.input.baseRef && f.inputs.items.some(i => inputKey(i) === r.key);
}
function ownerCurrent(s, r, f, now) {
  if (!r.ownerKey) return null;
  const request = s.requests.find(q => q.key === r.ownerKey);
  if (!request || !sameRun(request.request, r.execution) || request.fulfilled || !Array.isArray(f.ownerChecks)) return false;
  const observations = f.ownerChecks.map(check => ownerRequests(check.observation, check.expected, now));
  if (observations.some(value => value.status !== 'Known')) return false;
  const matches = observations.flatMap(value => value.items);
  if (new Set(matches.map(ownerRequestKey)).size !== matches.length) return false;
  return matches.filter(q => ownerRequestKey(q) === request.key && inputKey(q.input) === r.key).length === 1 ? request : false;
}
function choose(s, f, now) {
  let p;
  try { p = prerequisites(s, f, now); } catch {
    s.lastDecision = { observedAt: now, selected: [], held: [], reason: 'Evidence unknown' };
    return answer('Unknown', 'Evidence unknown');
  }
  if (p.reason) { s.lastDecision = { observedAt: now, selected: [], held: [], reason: p.reason }; return answer('Held', p.reason); }
  const reasons = [], candidates = [];
  for (const r of s.inputs.filter(r => r.pending)) {
    let reason = null;
    const owner = ownerCurrent(s, r, f, now);
    if (!current(r, f, p.g)) reason = 'Current input unknown';
    else if (active(s).some(o => o.key === r.key)) reason = 'Reservation retained';
    else if (owner === false) reason = 'Owner authority unknown';
    else {
      const check = recoveryDecision({ ...r, dailyRecoveries: s.daily[recoveryKey(r.input, now)] || 0,
        lastRecoveryAt: s.lastRecovery[headKey(r.input)] ?? null, requestReentries: owner?.reentries || 0,
        ownerRequest: owner?.request || null }, now);
      if (check.status !== 'Eligible') reason = check.reason;
      if (!reason && r.mode === 'recovery' && (active(s).some(o => sameRun(o.execution, r.execution)) ||
        !Array.isArray(f.terminal) || !f.terminal.some(e => releaseDecision({ execution: r.execution, mutation: 'none' }, e, now).status === 'Release'))) reason = 'Whole run reconciliation required';
    }
    if (reason) reasons.push({ input: r.input, reason }); else candidates.push(r);
  }
  const stacks = [...new Set(candidates.map(r => p.g.roots.get(prKey(r.input))))].map(key => ({ key,
    rows: candidates.filter(r => p.g.roots.get(prKey(r.input)) === key) }));
  const order = (a, b) => a.readyAt - b.readyAt || a.input.repoId - b.input.repoId || a.input.pr - b.input.pr ||
    Number(b.mandatory) - Number(a.mandatory) || a.input.workload.localeCompare(b.input.workload, 'en');
  stacks.sort((a, b) => order([...a.rows].sort(order)[0], [...b.rows].sort(order)[0]));
  const cursor = stacks.findIndex(x => x.key === s.cursor);
  const round = cursor < 0 ? stacks : [...stacks.slice(cursor + 1), ...stacks.slice(0, cursor + 1)];
  const selected = [];
  let madeProgress;
  do {
    madeProgress = false;
    for (const stack of round) {
      // First choose a topological frontier, then a PR, then its mandatory
      // workload. Mixing ancestor precedence into a ready-time comparator is
      // non-transitive for branched stacks and can admit a descendant first.
      const frontier = stack.rows.filter(r => !stack.rows.some(other =>
        p.g.ancestors.get(prKey(r.input)).has(prKey(other.input))));
      const groups = [...new Set(frontier.map(r => prKey(r.input)))].map(key =>
        frontier.filter(r => prKey(r.input) === key).sort(order));
      groups.sort((a, b) => order(a[0], b[0]));
      const r = groups[0]?.sort((a, b) => Number(b.mandatory) - Number(a.mandatory) || order(a, b))[0];
      if (!r) continue;
      const retainedRepos = new Set([r.input.repoId, ...active(s).map(o => o.input.repoId)]);
      // Adding one reservation consumes one unit in every retained repository's
      // conservative placement, so each must have positive room BEFORE adding it.
      if (initialAuthority(s, r) || [...retainedRepos].some(repoId => capacity(s, f.capacity, now, repoId) <= 0)) continue;
      if (r.mode === 'recovery' && active(s).some(o => sameRun(o.execution, r.execution))) continue;
      ensure(s.obligations.length < MAX_RECORDS && id(s.generation + 1));
      const generation = ++s.generation;
      const x = { ...r.execution, generation };
      const o = { generation, key: r.key, input: r.input, execution: x, origin: x, policy: null,
        expectedAttempt: r.mode === 'recovery' ? f.terminal.find(e => releaseDecision({ execution: r.execution, mutation: 'none' }, e, now).status === 'Release').run.attempt + 1 : x.attempt,
        activationId: f.safety.activation.id, reservedAt: now, phase: 'Reserved', mutation: r.mode === 'recovery' ? 'intent' : 'none',
        ownerKey: r.ownerKey, released: false, launch: null, checkout: null, appId: f.schedulerAppId };
      s.obligations.push(o);
      if (r.mode === 'recovery') {
        const dailyKey = recoveryKey(r.input, now); ensure(Object.keys(s.daily).length < MAX_LEDGER || dailyKey in s.daily);
        s.daily[dailyKey] = (s.daily[dailyKey] || 0) + 1; s.lastRecovery[headKey(r.input)] = now;
        if (r.ownerKey) s.requests.find(q => q.key === r.ownerKey).reentries++;
      }
      selected.push({ input: r.input, execution: x, generation, mutation: o.mutation });
      s.cursor = stack.key; stack.rows.splice(stack.rows.indexOf(r), 1); madeProgress = true;
    }
  } while (madeProgress);
  for (const stack of round) for (const r of stack.rows) reasons.push({ input: r.input,
    reason: initialAuthority(s, r) ? 'Actual job authority retained' : r.mode === 'recovery' && active(s).some(o => sameRun(o.execution, r.execution)) ? 'Run mutation serialized' : 'Shared capacity held' });
  s.lastDecision = { observedAt: now, selected, held: reasons,
    reason: selected.length ? 'Shadow reservations planned' : 'No eligible capacity or work' };
  return answer(selected.length ? 'Planned' : 'Held', s.lastDecision.reason, selected);
}
function bind(s, c, now) {
  const o = byGeneration(s, c.generation), x = execution(c.execution);
  ensure(x.generation === o.generation && sameRun(x, o.origin) && complete(c.jobs, now, closedJob) &&
    c.jobs.items.every(j => sameRun(j, x) && j.attempt === x.attempt));
  if (o.mutation !== 'none' && o.mutation !== 'confirmed') {
    // This is a trusted-adapter model assertion, NOT a decoder of an API response.
    ensure(c.appId === o.appId && x.attempt === o.expectedAttempt);
  } else ensure(x.attempt === o.execution.attempt && x.rootJobId === o.execution.rootJobId &&
    (o.execution.heavyJobId === null || o.execution.heavyJobId === x.heavyJobId));
  ensure((o.mutation === 'none' || c.jobs.items.filter(j => j.role === 'root').length === 1) &&
    c.jobs.items.filter(j => j.role === 'root' && j.workload === o.input.workload).length === 1 &&
    c.jobs.items.filter(j => j.role === 'heavy' && j.workload === o.input.workload).length <= 1 &&
    c.jobs.items.some(j => j.id === x.rootJobId && j.role === 'root' && j.workload === o.input.workload) &&
    (c.jobs.items.find(j => j.role === 'heavy' && j.workload === o.input.workload)?.id ?? null) === x.heavyJobId);
  ensure(!s.obligations.some(other => other.generation !== o.generation &&
    [other.execution.rootJobId, other.execution.heavyJobId].filter(id).some(n => [x.rootJobId, x.heavyJobId].includes(n)) && other.execution.repoId === x.repoId));
  ensure(!o.checkout && o.phase !== 'Active');
  o.execution = x; if (o.mutation !== 'none') { o.mutation = 'confirmed'; if (o.phase === 'Unknown') o.phase = 'Reserved'; }
  return answer('Recorded', 'Exact simulated binding');
}
function permit(s, c, now) {
  const o = byGeneration(s, c.generation), p = prerequisites(s, c.frame, now);
  ensure(!p.reason && c.frame.safety.activation.id === o.activationId && current(record(s, o.key), c.frame, p.g) && ownerCurrent(s, record(s, o.key), c.frame, now) !== false &&
    ['none', 'confirmed'].includes(o.mutation) && c.appId === o.appId && c.frame.schedulerAppId === o.appId && id(c.checkId) && ['launch', 'checkout'].includes(c.phase));
  ensure(active(s).every(q => capacity(s, c.frame.capacity, now, q.input.repoId) >= 0));
  ensure(!s.obligations.some(q => [q.launch?.id, q.checkout?.id].includes(c.checkId)));
  if (c.phase === 'launch') ensure(!o.launch && o.phase === 'Reserved' && o.execution.heavyJobId === null && now - o.reservedAt <= CANDIDATES.evidenceMs);
  else ensure(o.launch && !o.checkout && o.phase !== 'Held' && id(o.execution.heavyJobId) &&
    now < o.launch.expiresAt && c.appId === o.launch.appId);
  const value = { id: c.checkId, appId: c.appId, input: o.input, execution: clone(o.execution),
    phase: c.phase, status: 'completed', conclusion: 'success', launchIssuedAt: o.launch?.issuedAt ?? now,
    issuedAt: now, expiresAt: now + CANDIDATES.permitMs };
  o[c.phase] = value; o.appId = c.appId; if (c.phase === 'checkout') o.phase = 'Bound';
  return answer('Recorded', 'Simulated permit only');
}
function settle(s, c, now) {
  const o = byGeneration(s, c.generation), r = record(s, o.key);
  ensure(releaseDecision(o, c.evidence, now).status === 'Release' &&
    ['before_checkout', 'after_checkout', 'unknown'].includes(c.checkpoint) &&
    ['held', 'success', 'failure', 'unknown'].includes(c.outcome));
  const actual = c.evidence.items.filter(j => j.attempt === o.execution.attempt && j.workload === o.input.workload);
  const roots = actual.filter(j => j.role === 'root'), heavies = actual.filter(j => j.role === 'heavy');
  ensure(roots.length === 1 && roots[0].id === o.execution.rootJobId && heavies.length <= 1 &&
    (heavies.length ? heavies[0].id === o.execution.heavyJobId : o.execution.heavyJobId === null));
  ensure(c.evidence.items.filter(j => j.role === 'heavy' && j.workload === o.input.workload).every(j =>
    s.obligations.some(known => sameRun(known.execution, j) && known.execution.attempt === j.attempt &&
      known.execution.heavyJobId === j.id)));
  ensure(!(o.phase === 'Active' && c.checkpoint === 'before_checkout'));
  if (c.outcome === 'success') ensure(c.checkpoint === 'after_checkout' && id(o.execution.heavyJobId) &&
    c.evidence.items.some(j => j.id === o.execution.heavyJobId && j.conclusion === 'success'));
  const latch = failureLatch(r.failureLatched, c); ensure(latch !== null);
  r.failureLatched = latch; r.pending = false; r.mode = 'recovery';
  if (c.outcome === 'success') { r.success = true; r.successExecution = clone(o.execution); }
  if (o.ownerKey && c.checkpoint !== 'before_checkout') s.requests.find(q => q.key === o.ownerKey).fulfilled = true;
  o.released = true; o.phase = c.outcome === 'success' ? 'Completed' : latch ? 'Failed' : 'Held';
  o.terminalAt = now;
  for (const jobId of [o.execution.rootJobId, o.execution.heavyJobId].filter(id)) {
    const key = `${o.execution.repoId}/${jobId}`;
    if (!s.ledger.some(j => j.key === key)) {
      ensure(s.ledger.length < MAX_LEDGER);
      s.ledger.push({ key, input: o.input, execution: clone(o.execution), jobId, generation: o.generation,
        runnerType: 'unknown', createdAt: null, startedAt: null, completedAt: null,
        roundedMinutes: null, day: null, observedAt: now });
    }
  }
  return answer('Recorded', 'Exact graph terminal');
}
function transition(s, c) {
  const now = c.now;
  if (c.type.startsWith('writer-')) return writerTransition(s, c, {
    choose, bind, permit, prerequisites, capacity, current, ownerCurrent, record, byGeneration, active, answer, ensure });
  // Legacy commands remain shadow simulations, never alternate writer receipts.
  if (['bind', 'permit', 'lost'].includes(c.type)) ensure(!byGeneration(s, c.generation).writerManaged);
  if (c.type === 'settle') ensure(!writerState(s).writes.some(w => w.generation === c.generation &&
    ['intent', 'unresolved'].includes(w.state)));
  switch (c.type) {
    case 'queue': {
      const i = identity(c.input), x = execution(c.execution), key = inputKey(i);
      ensure(i.repoId === x.repoId && clock(c.readyAt) && c.readyAt <= now && typeof c.mandatory === 'boolean' && ['initial', 'recovery'].includes(c.mode));
      let r = s.inputs.find(r => r.key === key);
      ensure(!active(s).some(o => o.key === key));
      if (r?.ownerKey) ensure(sameRun(s.requests.find(q => q.key === r.ownerKey)?.request ?? {}, x));
      ensure(c.mode !== 'initial' || !s.obligations.some(o => o.key === key && sameRun(o.origin, x) && o.origin.attempt === x.attempt));
      if (!r) { ensure(s.inputs.length < MAX_RECORDS); r = { key, input: i, readyAt: c.readyAt,
        intentCreatedAt: now, success: false, failureLatched: false, successExecution: null, ownerKey: null }; s.inputs.push(r); }
      r.readyAt = Math.min(r.readyAt, c.readyAt); r.execution = x; r.mode = c.mode; r.mandatory = c.mandatory; r.pending = true;
      return answer('Recorded', 'Waiting intent retained');
    }
    case 'owner': {
      const value = ownerRequests(c.observation, c.expected, now); ensure(value.status === 'Known');
      for (const request of value.items) {
        const key = ownerRequestKey(request), r = record(s, inputKey(request.input));
        if (s.requests.some(q => q.key === key)) continue;
        ensure(s.requests.length < MAX_RECORDS && !active(s).some(o => o.key === r.key));
        s.requests.push({ key, request: { ...request, input: identity(request.input) }, reentries: 0,
          fulfilled: false, intentCreatedAt: now, observedAt: now });
        r.ownerKey = key; r.failureLatched = false; r.intentCreatedAt = now; r.pending = true; r.mode = 'recovery';
        const heavy = c.observation.jobs.items.filter(j => j.role === 'heavy' && j.workload === request.workload); ensure(heavy.length <= 1);
        r.execution = { repoId: request.repoId, runId: request.runId, attempt: request.ownerAttempt,
          rootJobId: request.rootJobId, heavyJobId: heavy[0]?.id ?? null, generation: 1 };
      }
      return answer('Recorded', 'Scoped owner requests deduplicated');
    }
    case 'decide': return choose(s, c.frame, now);
    case 'lost': { const o = byGeneration(s, c.generation); ensure(o.mutation === 'intent' || o.mutation === 'unresolved');
      o.mutation = 'unresolved'; o.phase = 'Unknown'; return answer('Recorded', 'Mutation unresolved'); }
    case 'bind': return bind(s, c, now);
    case 'permit': return permit(s, c, now);
    case 'consume': {
      const o = byGeneration(s, c.generation); ensure(o.checkout && o.phase === 'Bound' && now < o.checkout.expiresAt &&
        c.evidence?.items?.length === 1 && c.evidence.items[0].issuedAt === o.checkout.issuedAt &&
        c.evidence.items[0].expiresAt === o.checkout.expiresAt && permitDecision(c.evidence,
        { input: o.input, execution: o.execution, appId: o.appId, checkId: o.checkout.id,
          phase: 'checkout', launchIssuedAt: o.launch.issuedAt }, now).status === 'Verified');
      o.phase = 'Active'; return answer('Recorded', 'Simulated exact checkout consumed');
    }
    case 'settle': return settle(s, c, now);
    case 'ledger': {
      const o = s.obligations.find(o => o.generation === c.generation); ensure(o && id(c.jobId) && [o.execution.rootJobId, o.execution.heavyJobId].includes(c.jobId) &&
        ['hosted', 'self-hosted', 'unknown'].includes(c.runnerType) && clock(c.createdAt) && clock(c.startedAt) && clock(c.completedAt) &&
        c.createdAt <= c.startedAt && c.startedAt <= c.completedAt && c.completedAt <= now &&
        (c.roundedMinutes === null || (Number.isSafeInteger(c.roundedMinutes) && c.roundedMinutes >= 0)) &&
        (c.runnerType !== 'self-hosted' || c.roundedMinutes === null || c.roundedMinutes === 0));
      const key = `${o.execution.repoId}/${c.jobId}`, day = accountingDay(c.createdAt) === accountingDay(c.completedAt) ? accountingDay(c.createdAt) : null;
      const entry = { key, input: o.input, execution: clone(o.execution), jobId: c.jobId, generation: o.generation,
        runnerType: c.runnerType, createdAt: c.createdAt, startedAt: c.startedAt, completedAt: c.completedAt,
        roundedMinutes: c.roundedMinutes, day, observedAt: now };
      const prior = s.ledger.find(j => j.key === key);
      if (prior) {
        const merged = clone(prior);
        for (const key of ['createdAt', 'startedAt', 'completedAt', 'roundedMinutes', 'day']) if (merged[key] === null) merged[key] = entry[key];
        if (merged.runnerType === 'unknown') merged.runnerType = entry.runnerType;
        if (merged.execution.heavyJobId === null) merged.execution.heavyJobId = entry.execution.heavyJobId;
        merged.observedAt = now;
        ensure(JSON.stringify(merged) === JSON.stringify(entry)); Object.assign(prior, entry);
      } else { ensure(s.ledger.length < MAX_LEDGER); s.ledger.push(entry); }
      return answer('Recorded', day === null ? 'Cross-date billing unresolved' : 'Job accounting recorded');
    }
    case 'tick':
      for (const o of active(s)) if (o.phase !== 'Active' &&
        ((!o.launch && now - o.reservedAt > CANDIDATES.evidenceMs) ||
          (o.launch && !o.checkout && now >= o.launch.expiresAt) || (o.checkout && now >= o.checkout.expiresAt))) o.phase = 'Held';
      return answer('Recorded', 'Expired rights fenced; obligations retained');
    default: throw new Error('Unknown shadow command');
  }
}

// storage is the SQLite DO port: sql.exec(...).toArray(), transactionSync(fn).
// Exactly one future object owns BOTH repos. It must never be sharded by repo.
// No async callback or in-memory authority; each command re-reads durable state.
export class ShadowController {
  constructor(storage) {
    ensure(storage?.sql && typeof storage.sql.exec === 'function' && typeof storage.transactionSync === 'function');
    this.storage = storage;
    storage.transactionSync(() => {
      this.exec('CREATE TABLE IF NOT EXISTS shadow_state (id INTEGER PRIMARY KEY CHECK (id = 1), body TEXT NOT NULL)');
      this.exec('CREATE TABLE IF NOT EXISTS shadow_audit (id INTEGER PRIMARY KEY, at INTEGER NOT NULL, kind TEXT NOT NULL, policy TEXT NOT NULL, body TEXT NOT NULL)');
      const rows = this.exec('SELECT body FROM shadow_state WHERE id = 1');
      if (!rows.length) { ensure(this.exec('SELECT id FROM shadow_audit LIMIT 1').length === 0);
        this.exec('INSERT INTO shadow_state (id, body) VALUES (1, ?)', JSON.stringify(initial())); }
      else this.read();
    });
  }
  exec(sql, ...params) { return this.storage.sql.exec(sql, ...params).toArray(); }
  read() { const rows = this.exec('SELECT body FROM shadow_state WHERE id = 1'); ensure(rows.length === 1);
    let state; try { state = JSON.parse(rows[0].body); } catch { ensure(false); } validateState(state); return state; }
  apply(c) {
    ensure(c && id(c.id) && clock(c.now) && tag(c.policy) && tag(c.type));
    return this.storage.transactionSync(() => {
      const s = this.read();
      const previous = this.exec('SELECT body FROM shadow_audit WHERE id = ?', c.id);
      if (previous.length) {
        const saved = JSON.parse(previous[0].body);
        if (c.type.startsWith('writer-') || saved.commandDigest) ensure(saved.commandDigest === commandDigest(c));
        return saved.response;
      }
      ensure(c.now >= s.lastAt && s.revision < MAX_COMMANDS);
      const before = c.type.startsWith('writer-') ? clone(s) : null;
      const response = transition(s, c);
      s.revision++; s.lastAt = c.now;
      for (const o of s.obligations) if (o.policy === null) o.policy = c.policy;
      validateState(s);
      const delta = before ? writerAudit(s, before, c) : null;
      const targetGenerations = c.type === 'decide' ? response.selected.map(q => q.generation) : id(c.generation) ? [c.generation] : [];
      const targets = targetGenerations.map(generation => {
        const o = s.obligations.find(o => o.generation === generation);
        return { input: o.input, execution: o.execution, generation, mutation: o.mutation, phase: o.phase,
          ownerKey: o.ownerKey, launch: o.launch, checkout: o.checkout };
      });
      if (delta) for (const target of delta.targets) if (!targets.some(t => t.generation === target.generation)) targets.push(target);
      if (c.type === 'queue') { const r = record(s, inputKey(c.input)); targets.push({ input: r.input,
        execution: r.execution, readyAt: r.readyAt, intentCreatedAt: r.intentCreatedAt, ownerKey: r.ownerKey }); }
      if (c.type === 'owner') for (const q of s.requests) targets.push({ input: q.request.input,
        ownerKey: q.key, intentCreatedAt: q.intentCreatedAt, reentries: q.reentries });
      const audit = { response, targets,
        commandDigest: c.type.startsWith('writer-') ? commandDigest(c) : null,
        writer: delta, actor: { kind: 'shadow-model',
        ownerId: c.type === 'owner' ? APPROVED.ownerId : null },
        evidenceAt: c.type === 'bind' && clock(c.jobs?.observedAt) ? c.jobs.observedAt :
          ['settle', 'consume'].includes(c.type) && clock(c.evidence?.observedAt) ? c.evidence.observedAt : null,
        classification: c.type === 'settle' ? { checkpoint: c.checkpoint, outcome: c.outcome } : null,
        target: id(c.generation) ? c.generation : null,
        ownerRequests: c.type === 'owner' ? s.requests.map(q => q.key) : [],
        ledger: c.type === 'ledger' ? s.ledger.filter(j => j.generation === c.generation && j.jobId === c.jobId) : [], revision: s.revision };
      this.exec('UPDATE shadow_state SET body = ? WHERE id = 1', JSON.stringify(s));
      this.exec('INSERT INTO shadow_audit (id, at, kind, policy, body) VALUES (?, ?, ?, ?, ?)', c.id, c.now, c.type, c.policy, JSON.stringify(audit));
      return clone(response);
    });
  }
  snapshot(now) {
    ensure(clock(now)); const s = this.read(); ensure(now >= s.lastAt);
    return { version: VERSION, mode: 'DISABLED_SHADOW', observedAt: s.lastAt, viewedAt: now,
      stale: !fresh(s.lastAt, now), revision: s.revision, cursor: s.cursor, inputs: clone(s.inputs),
      reservations: clone(active(s)).map(o => ({ ...o, reconciliationMs: reconciliationInterval(o.launch?.issuedAt, now) })),
      history: clone(s.obligations.filter(o => o.released)), daily: clone(s.daily), requests: clone(s.requests),
      accounting: accounting(s), ledger: clone(s.ledger), writer: clone(writerState(s)), lastDecision: clone(s.lastDecision), effects: [] };
  }
}
