const { test } = require('node:test');
const assert = require('node:assert/strict');
const fixtures = require('./fixtures/ci-admission.json');
const policy = import('./lib/ci-admission.mjs');
const now = Date.parse('2026-11-21T10:00:00Z');
const input = { repoId: 1305651079, pr: 42, head: 'a'.repeat(40),
  baseRef: 'main', baseSha: 'b'.repeat(40), mergeSha: 'c'.repeat(40),
  workflow: '.github/workflows/ci.yml', digest: 'd'.repeat(64),
  workload: 'verify', capability: 'fast' };
const execution = { repoId: input.repoId, runId: 100, attempt: 2,
  rootJobId: 201, heavyJobId: null, generation: 3 };
const list = (items, extra = {}) => ({ items, complete: true, observedAt: now, ...extra });
const job = (id, extra = {}) => ({ id, repoId: input.repoId, runId: 100,
  attempt: 2, status: 'completed', conclusion: 'success', role: 'root',
  workload: 'verify', ...extra });
const copy = value => structuredClone(value);

function permit(phase = 'launch') {
  const expected = { input, execution: { ...execution, heavyJobId: phase === 'checkout' ? 202 : null },
    phase, appId: 900, checkId: 301, launchIssuedAt: now - 1000 };
  return { expected, evidence: list([{ id: 301, appId: 900, input,
    execution: { ...expected.execution }, phase, status: 'completed', conclusion: 'success',
    launchIssuedAt: now - 1000, issuedAt: now - 1000, expiresAt: now + 119000 }]) };
}

function owner() {
  return { attempt: { repoId: input.repoId, runId: 100, number: 2,
    triggeringActorId: 37964907, triggeringActorType: 'User', input, observedAt: now },
  jobs: list([job(201)]), refs: { input, observedAt: now },
  permission: { actorId: 37964907, value: 'admin', observedAt: now } };
}

function recovery(extra = {}) {
  return { input, readyAt: now - 600000, intentCreatedAt: now - 600000, lastRecoveryAt: now - 300000,
    dailyRecoveries: 0, requestReentries: 0, success: false, failureLatched: false,
    ownerRequest: null, ...extra };
}

function safety() {
  return { activation: { id: 'later-owner-record', ownerAuthorized: true,
    startedAt: now - 1000, expiresAt: now - 1000 + 7 * 86400000 },
  paused: false, revoked: false, backoffUntil: null,
  rate: { readsHour: 0, writesHour: 0, writesMinute: 0, headroom: 0.25, complete: true, observedAt: now },
  accounting: { status: 'Known', hostedMinutesDay: 0, hostedMinutesTotal: 0,
    unexpectedHostedJobs: 0, hostedReservations: 0, zeroHostedClosure: true, complete: true, observedAt: now } };
}

test('immutable input identity ignores execution and policy provenance', async () => {
  const { inputKey, executionKey, recoveryKey, ownerRequestKey } = await policy;
  assert.ok(inputKey(input));
  assert.equal(inputKey(input), inputKey({ ...input, runId: 99, policy: 'next' }));
  for (const [field, value] of Object.entries({ repoId: 1318535693, pr: 43,
    head: 'e'.repeat(40), baseRef: 'stack-parent', baseSha: 'e'.repeat(40),
    mergeSha: 'e'.repeat(40), workflow: 'other.yml', digest: 'e'.repeat(64),
    workload: 'storybook', capability: 'light' })) {
    assert.notEqual(inputKey(input), inputKey({ ...input, [field]: value }), field);
  }
  assert.notEqual(executionKey(execution), executionKey({ ...execution, runId: 101 }));
  assert.notEqual(executionKey(execution), executionKey({ ...execution, generation: 4 }));
  assert.equal(recoveryKey(input, now), recoveryKey({ ...input, pr: 43,
    baseSha: 'e'.repeat(40), digest: 'e'.repeat(64), capability: 'light' }, now));
  assert.notEqual(recoveryKey(input, now), recoveryKey({ ...input, head: 'e'.repeat(40) }, now));
  assert.notEqual(ownerRequestKey({ ...execution, ownerAttempt: 2 }),
    ownerRequestKey({ ...execution, ownerAttempt: 3 }));
  for (const id of ['1305651079', 0, -1, Number.MAX_SAFE_INTEGER + 1]) {
    assert.equal(inputKey({ ...input, repoId: id }), null);
  }
  assert.equal(inputKey({ ...input, head: 'bad' }), null);
  assert.equal(executionKey({ ...execution, heavyJobId: execution.rootJobId }), null);
  assert.equal(ownerRequestKey({ ...execution, ownerAttempt: 1 }), null);
});

test('accounting keys use Jerusalem midnight and both DST boundaries', async () => {
  const { accountingDay, recoveryKey } = await policy;
  for (const [stamp, day] of [
    ['2026-11-21T21:59:59.999Z', '2026-11-21'], ['2026-11-21T22:00:00Z', '2026-11-22'],
    ['2026-03-26T21:59:59Z', '2026-03-26'], ['2026-03-26T22:00:00Z', '2026-03-27'],
    ['2026-03-26T23:59:59Z', '2026-03-27'], ['2026-03-27T00:00:00Z', '2026-03-27'],
    ['2026-10-24T21:00:00Z', '2026-10-25'], ['2026-10-24T23:00:00Z', '2026-10-25'],
    ['2026-10-25T00:00:00Z', '2026-10-25']]) {
    assert.equal(accountingDay(Date.parse(stamp)), day, stamp);
  }
  assert.notEqual(recoveryKey(input, Date.parse('2026-11-21T21:59:59Z')),
    recoveryKey(input, Date.parse('2026-11-21T22:00:00Z')));
  assert.equal(accountingDay(NaN), null);
});

test('missing, malformed, partial, stale and conflicting lists are Unknown', async () => {
  const { observeList } = await policy;
  assert.equal(observeList(list([]), now).status, 'Known');
  assert.equal(observeList(list([{ id: 1 }], { observedAt: now - 60000 }), now).status, 'Known');
  for (const evidence of [null, {}, list(null), list({ id: 1 }), list([], { complete: false }),
    list([], { observedAt: now - 60001 }), list([], { observedAt: now + 1 }),
    list([{ id: '1' }]), list([{ id: 1 }, { id: 1 }])]) {
    assert.equal(observeList(evidence, now).status, 'Unknown');
  }
});

test('root launch verification needs no heavy ID; checkout needs exact actual job', async () => {
  const { permitDecision } = await policy;
  for (const phase of ['launch', 'checkout']) {
    const { expected, evidence } = permit(phase);
    const before = copy(evidence);
    assert.equal(permitDecision(evidence, expected, now).status, 'Verified');
    assert.deepEqual(evidence, before);
    assert.equal(permitDecision(evidence, expected, now + 119000).status, 'Unknown');
    for (const change of [c => { c.appId++; }, c => { c.id++; },
      c => { c.execution.rootJobId++; }, c => { c.execution.attempt++; },
      c => { c.execution.generation++; }, c => { c.execution.repoId = 1318535693; },
      c => { c.execution.runId++; }, c => { c.input.baseSha = 'f'.repeat(40); },
      c => { c.input.head = 'f'.repeat(40); }, c => { c.input.mergeSha = 'f'.repeat(40); },
      c => { c.input.digest = 'f'.repeat(64); }, c => { c.status = 'new_status'; },
      c => { c.conclusion = 'neutral'; }, c => { c.launchIssuedAt--; },
      c => { c.expiresAt++; }]) {
      const bad = copy(evidence); change(bad.items[0]);
      assert.equal(permitDecision(bad, expected, now).status, 'Unknown');
    }
    const duplicate = copy(evidence); duplicate.items.push(copy(duplicate.items[0]));
    assert.equal(permitDecision(duplicate, expected, now).status, 'Unknown');
    duplicate.items[1].id++;
    assert.equal(permitDecision(duplicate, expected, now).status, 'Unknown');
  }
  const checkout = permit('checkout');
  checkout.expected.execution.heavyJobId = 203;
  assert.equal(permitDecision(checkout.evidence, checkout.expected, now).status, 'Unknown');
});

test('phase offsets and light delay cannot renew or publish after launch expiry', async () => {
  const { permitDecision, reconciliationInterval } = await policy;
  for (const offset of [0, 1, 4999, 5000, 59999, 119999, 120000, 150000]) {
    const p = permit();
    p.expected.launchIssuedAt = now;
    Object.assign(p.evidence.items[0], { launchIssuedAt: now, issuedAt: now, expiresAt: now + 120000 });
    p.evidence.observedAt = now + offset;
    assert.equal(permitDecision(p.evidence, p.expected, now + offset).status,
      offset < 120000 ? 'Verified' : 'Unknown');
    assert.equal(reconciliationInterval(now, now + offset), offset < 120000 ? 5000 : 60000);
  }
  const p = permit('checkout');
  Object.assign(p.evidence.items[0], { issuedAt: now + 119000, expiresAt: now + 239000 });
  p.evidence.observedAt = now + 119000;
  assert.equal(permitDecision(p.evidence, p.expected, now + 119000).status, 'Unknown');
  p.evidence.items[0].issuedAt--;
  p.evidence.items[0].expiresAt--;
  assert.equal(permitDecision(p.evidence, p.expected, now + 119000).status, 'Verified');
});

test('only complete terminal evidence of exact jobs releases reservations', async () => {
  const { releaseDecision } = await policy;
  const reservation = { execution: { ...execution, heavyJobId: 202 }, mutation: 'confirmed' };
  const evidence = list([job(201), job(202, { role: 'heavy' }),
    job(99, { attempt: 1, role: 'other' })],
  { run: { repoId: input.repoId, id: 100, attempt: 2, status: 'completed' }, coveredAttempts: [1, 2] });
  assert.equal(releaseDecision(reservation, evidence, now).status, 'Release');
  for (const change of [e => { e.items[1].status = 'in_progress'; e.items[1].conclusion = null; },
    e => { e.items[1].id++; }, e => { e.items[0].attempt++; }, e => { e.items[1].runId++; },
    e => { e.run.status = 'queued'; }, e => { e.run.id++; }, e => { e.items[2].conclusion = 'new'; },
    e => { e.items[2].status = 'in_progress'; e.items[2].conclusion = null; },
    e => { e.coveredAttempts = [2]; }, e => { e.complete = false; }]) {
    const bad = copy(evidence); change(bad);
    assert.equal(releaseDecision(reservation, bad, now).status, 'Unknown');
  }
  for (const mutation of ['intent', 'unresolved', '2xx', 'new']) {
    assert.equal(releaseDecision({ ...reservation, mutation }, evidence, now).status, 'Unknown');
  }
  assert.equal(releaseDecision({ ...reservation, leaseExpired: true, restarted: true },
    list([]), now).status, 'Unknown');
});

test('owner scope is attempt-specific, paged, current and exactly the rerun roots', async () => {
  const { ownerRequests } = await policy;
  const expected = { input, rootInputs: ['verify', 'storybook', 'ai'].map(workload => ({ ...input, workload })) };
  const one = ownerRequests(owner(), expected, now);
  assert.equal(one.status, 'Known'); assert.equal(one.items.length, 1);
  const all = owner(); all.jobs.items.push(job(202, { workload: 'storybook' }));
  assert.equal(ownerRequests(all, expected, now).items.length, 2);
  for (const role of ['heavy', 'gate']) {
    const p = owner(); p.jobs.items[0].role = role;
    assert.deepEqual(ownerRequests(p, expected, now).items, []);
  }
  const app = owner(); app.attempt.triggeringActorId = 999; app.attempt.triggeringActorType = 'Bot';
  assert.deepEqual(ownerRequests(app, expected, now).items, []);
  assert.deepEqual(ownerRequests(owner(), expected, now), one); // durable key for dedup/reentry
  for (const change of [o => { o.jobs.complete = false; }, o => { o.attempt.number = 3; },
    o => { o.permission.value = 'read'; }, o => { o.permission.actorId++; },
    o => { o.refs.input.baseSha = 'e'.repeat(40); }, o => { o.jobs.items[0].workload = 'unknown'; },
    o => { o.attempt.observedAt -= 60001; }, o => { o.jobs.items[0].status = 'mystery'; }]) {
    const bad = copy(owner()); change(bad);
    assert.equal(ownerRequests(bad, expected, now).status, 'Unknown');
  }
});

test('success and failure survive held attempts and second runs; owner scope is bounded', async () => {
  const { recoveryDecision, ownerRequests } = await policy;
  const request = ownerRequests(owner(), { input, rootInputs: [input] }, now).items[0];
  assert.equal(recoveryDecision(recovery(), now).status, 'Eligible');
  for (const extra of [{ success: true }, { failureLatched: true }, { dailyRecoveries: 3 },
    { lastRecoveryAt: now - 299999 }, { readyAt: now - 86400000, intentCreatedAt: now - 86400000 },
    { failureLatched: true, runId: 101, attempt: 4, policy: 'changed', phase: 'Held' }]) {
    assert.equal(recoveryDecision(recovery(extra), now).status, 'Held');
  }
  assert.equal(recoveryDecision(recovery({ success: true, failureLatched: true,
    ownerRequest: request }), now).status, 'Eligible');
  assert.equal(recoveryDecision(recovery({ ownerRequest: request, requestReentries: 3 }), now).status, 'Held');
  assert.equal(recoveryDecision(recovery({ ownerRequest: { ...request, workload: 'storybook' } }), now).status, 'Unknown');
  assert.equal(recoveryDecision(recovery({ dailyRecoveries: undefined }), now).status, 'Unknown');
});

test('failure latches classify ambiguous checkout and cannot be erased by later holds', async () => {
  const { failureLatch } = await policy;
  assert.equal(failureLatch(false, { checkpoint: 'before_checkout', outcome: 'held' }), false);
  for (const checkpoint of ['after_checkout', 'unknown']) {
    for (const outcome of ['held', 'failure', 'unknown']) {
      assert.equal(failureLatch(false, { checkpoint, outcome }), true);
    }
  }
  assert.equal(failureLatch(true, { checkpoint: 'before_checkout', outcome: 'held' }), true);
  assert.equal(failureLatch(true, { checkpoint: 'after_checkout', outcome: 'success' }), true);
  assert.equal(failureLatch(false, null), null);
});

test('model UI Verify then Storybook recovery preserves sibling execution evidence', async () => {
  const { recoveryDecision, releaseDecision } = await policy;
  const retained = job(202, { role: 'heavy', attempt: 2 });
  const evidence = list([job(201), retained, job(301, { attempt: 3, workload: 'storybook' }),
    job(302, { attempt: 3, role: 'heavy', workload: 'storybook' })],
  { run: { repoId: input.repoId, id: 100, attempt: 3, status: 'completed' }, coveredAttempts: [1, 2, 3] });
  assert.equal(recoveryDecision(recovery({ success: true }), now).status, 'Held');
  assert.equal(recoveryDecision(recovery({ input: { ...input, workload: 'storybook' } }), now).status, 'Eligible');
  assert.equal(releaseDecision({ execution: { ...execution, heavyJobId: 202 }, mutation: 'confirmed' },
    evidence, now).status, 'Release');
  assert.deepEqual(evidence.items[1], retained);
  assert.equal(evidence.items[1].attempt, 2); // never relabel a sibling as attempt 3
});

test('pause, expiry, backoff and unexpected or unknown billing stop new work', async () => {
  const { newWorkDecision, APPROVED, CANDIDATES } = await policy;
  assert.equal(APPROVED.hostedMinutesDay, 600);
  assert.equal(CANDIDATES.managedFast, 2);
  assert.equal(newWorkDecision(safety(), now).status, 'Eligible');
  for (const change of [s => { s.paused = true; }, s => { s.revoked = true; },
    s => { s.backoffUntil = now + 1; }, s => { s.activation.startedAt = now + 1;
      s.activation.expiresAt = now + 1 + 7 * 86400000; },
    s => { s.activation.startedAt = now - 7 * 86400000; s.activation.expiresAt = now; },
    s => { s.rate.readsHour = 2500; }, s => { s.rate.writesHour = 100; },
    s => { s.rate.writesMinute = 10; }, s => { s.rate.headroom = 0.249; },
    s => { s.accounting.unexpectedHostedJobs = 1; }, s => { s.accounting.hostedMinutesDay = 601;
      s.accounting.hostedMinutesTotal = 601; },
    s => { s.accounting.hostedReservations = 1; }, s => { s.accounting.zeroHostedClosure = false; },
    s => { s.accounting.hostedMinutesTotal = 4201; }]) {
    const bad = safety(); change(bad);
    assert.equal(newWorkDecision(bad, now).status, 'Held');
  }
  for (const change of [s => { s.activation = null; }, s => { s.activation.expiresAt++; },
    s => { s.accounting.status = 'Unknown'; }, s => { s.accounting.hostedMinutesDay = null; },
    s => { s.rate.headroom = null; }, s => { s.paused = undefined; }]) {
    const bad = safety(); change(bad);
    assert.equal(newWorkDecision(bad, now).status, 'Unknown');
  }
  const s = safety(); s.paused = true;
  const expiry = s.activation.expiresAt; newWorkDecision(s, now);
  assert.equal(s.activation.expiresAt, expiry); // draining/rollback never cancel or extend clocks
});

test('portable recovery fixtures execute; future replay manifest retains deferred owners', async () => {
  const { recoveryDecision, CONTRACT_VERSION } = await policy;
  assert.equal(fixtures.contractVersion, CONTRACT_VERSION);
  for (const f of fixtures.recovery) {
    assert.equal(recoveryDecision(recovery(f.patch), now).status, f.status, f.id);
  }
  assert.deepEqual(fixtures.futureReplay.map(f => f.id), [
    'native-partial-recovery', 'durable-permits-and-mutations', 'owner-race-reentries',
    'stack-round-robin', 'shared-capacity', 'billing-and-safety']);
  for (const f of fixtures.futureReplay) {
    assert.ok(f.ownerStories.length && f.expect.length && f.proof);
  }
});

test('owner requests use enrolled per-root capability and full immutable inputs', async () => {
  const { ownerRequests, inputKey } = await policy;
  const aiInput = { ...input, workload: 'ai', capability: 'light' };
  const p = owner(); p.jobs.items.push(job(202, { workload: 'ai' }));
  const expected = { input, rootInputs: [input, aiInput] };
  const scoped = ownerRequests(p, expected, now);
  assert.equal(scoped.status, 'Known');
  assert.equal(inputKey(scoped.items[1].input), inputKey(aiInput));
  assert.notEqual(inputKey(scoped.items[1].input), inputKey({ ...aiInput, capability: 'fast' }));
  for (const bad of [[input, { ...aiInput, head: 'e'.repeat(40) }], [input, aiInput, aiInput],
    [{ ...input, digest: 'e'.repeat(64) }], []]) {
    assert.equal(ownerRequests(p, { input, rootInputs: bad }, now).status, 'Unknown');
  }
});

test('stale, missing or partial rate and billing coverage cannot permit new work', async () => {
  const { newWorkDecision } = await policy;
  for (const field of ['rate', 'accounting']) {
    for (const patch of [{ observedAt: now - 60001 }, { observedAt: undefined },
      { observedAt: now + 1 }, { complete: false }, { complete: undefined }]) {
      const s = safety(); Object.assign(s[field], patch);
      assert.equal(newWorkDecision(s, now).status, 'Unknown', `${field} ${JSON.stringify(patch)}`);
    }
  }
});

test('new owner waiting intent on an old ready PR preserves priority without premature expiry', async () => {
  const { recoveryDecision, ownerRequests } = await policy;
  const request = ownerRequests(owner(), { input, rootInputs: [input] }, now).items[0];
  const r = recovery({ readyAt: now - 2 * 86400000, intentCreatedAt: now - 1, success: true, ownerRequest: request });
  assert.equal(recoveryDecision(r, now).status, 'Eligible');
  const before = copy(r);
  assert.equal(recoveryDecision({ ...r, intentCreatedAt: now - 86400000 }, now).status, 'Held');
  assert.deepEqual(r, before); // no first-ready reset; App reentry must retain intent clock
});
