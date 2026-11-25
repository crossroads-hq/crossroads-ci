const { test } = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const { mkdtempSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { spawnSync } = require('node:child_process');
const load = () => import('./lib/ci-admission-shadow.mjs');
const T = Date.parse('2026-11-21T10:00:00Z');
const UI = 1305651079, EVO = 1318535693;
const input = (pr = 42, workload = 'Verify', repoId = UI) => ({ repoId, pr, head: 'a'.repeat(40),
  baseRef: 'main', baseSha: 'b'.repeat(40), mergeSha: 'c'.repeat(40), workflow: '.github/workflows/ci.yml',
  digest: 'd'.repeat(64), workload, capability: 'fast' });
const execution = (i, runId = 100, attempt = 1, rootJobId = 1000) => ({ repoId: i.repoId,
  runId, attempt, rootJobId, heavyJobId: null, generation: 1 });
const list = (items, now = T) => ({ items, complete: true, observedAt: now });
const job = (x, id, role, conclusion = 'failure', status = 'completed', workload = 'Verify') => ({ id,
  repoId: x.repoId, runId: x.runId, attempt: x.attempt, status, conclusion, role, workload });
const terminal = (x, now = T, extras = []) => ({ ...list([job(x, x.rootJobId, 'root'),
  ...(x.heavyJobId ? [job(x, x.heavyJobId, 'heavy', 'success')] : []), ...extras], now),
  run: { id: x.runId, repoId: x.repoId, attempt: x.attempt, status: 'completed' },
  coveredAttempts: Array.from({ length: x.attempt }, (_, n) => n + 1) });
function frame(inputs, now = T) {
  return { schedulerAppId: 900, inputs: { ...list(inputs, now), repoIds: [UI, EVO] },
    prs: { ...list([...new Map(inputs.map(i => [`${i.repoId}/${i.pr}`, { id: i.repoId + i.pr,
      repoId: i.repoId, pr: i.pr, headRef: `pr-${i.pr}`, baseRef: i.baseRef,
      open: true, draft: false, refsKnown: true }])).values()], now), repoIds: [UI, EVO] },
    capacity: { complete: true, observedAt: now, groups: [{ id: 1, slots: 2 }],
      runners: [19, 20, 21].map(id => ({ id, groupId: 1, repoIds: [UI, EVO],
        labels: id === 19 ? ['fast', 'light'] : ['fast'], online: true })), jobs: [] },
    safety: { activation: { id: 'synthetic-replay-only', ownerAuthorized: true,
      startedAt: T - 1000, expiresAt: T - 1000 + 7 * 86400000 }, paused: false, revoked: false,
      backoffUntil: null, rate: { complete: true, observedAt: now, readsHour: 0, writesHour: 0,
        writesMinute: 0, headroom: 1 }, accounting: { status: 'Known', complete: true, observedAt: now,
        hostedMinutesDay: 0, hostedMinutesTotal: 0, unexpectedHostedJobs: 0,
        hostedReservations: 0, zeroHostedClosure: true } }, terminal: [], ownerChecks: [] };
}
function sqlite(db) {
  return { sql: { exec(sql, ...args) { const s = db.prepare(sql); return {
    toArray: () => s.all(...args) }; } }, transactionSync(fn) {
    db.exec('BEGIN IMMEDIATE'); try { const value = fn(); db.exec('COMMIT'); return value;
    } catch (e) { db.exec('ROLLBACK'); throw e; }
  } };
}
async function rig(t, file = ':memory:') {
  const { ShadowController } = await load();
  const db = new DatabaseSync(file); t.after(() => { if (db.isOpen) db.close(); });
  const c = new ShadowController(sqlite(db)); let seq = 0;
  return { c, db, send: (type, payload = {}, now = T) => c.apply({ id: ++seq, now,
    policy: 'shadow-v1', type, ...payload }) };
}
const queue = (r, i = input(), x = execution(i), mode = 'initial', now = T) => r.send('queue',
  { input: i, execution: x, readyAt: T - 1000, mandatory: i.workload !== 'AI', mode }, now);

test('complete bind cannot discard an observed heavy ID or later substitute it', async t => {
  const r = await rig(t), i = input(), x = execution(i); queue(r, i);
  r.send('decide', { frame: frame([i]) });
  const jobs = list([job(x, 1000, 'root'), job(x, 1001, 'heavy')]);
  assert.throws(() => r.send('bind', { generation: 1, execution: x, jobs }), /Unknown/);
  r.send('bind', { generation: 1, execution: { ...x, heavyJobId: 1001 }, jobs });
  assert.throws(() => r.send('bind', { generation: 1, execution: { ...x, heavyJobId: 1002 },
    jobs: list([job(x, 1000, 'root'), job(x, 1002, 'heavy')]) }), /Unknown/);
});

test('null actual ledger ID never creates known zero accounting', async t => {
  const r = await rig(t), i = input(); queue(r, i); r.send('decide', { frame: frame([i]) });
  assert.throws(() => r.send('ledger', { generation: 1, jobId: null,
    runnerType: 'self-hosted', createdAt: T, startedAt: T, completedAt: T, roundedMinutes: 0 }), /Unknown/);
  assert.equal(r.c.snapshot(T).accounting.status, 'Unknown');
  assert.deepEqual(r.c.snapshot(T).ledger, []);
});

test('replacing queued execution cannot transfer owner authority to a different run', async t => {
  const r = await rig(t), i = input(); queue(r, i); r.send('owner', ownerCheck(i, T));
  assert.throws(() => queue(r, i, execution(i, 200, 1, 3000), 'recovery'), /Unknown/);
  assert.equal(r.c.snapshot(T).inputs[0].execution.runId, 100);
});

test('each permit rechecks retained feasibility without requiring an extra free slot', async t => {
  for (const phase of ['launch', 'checkout']) for (const change of ['unmanaged', 'shrink']) {
    const r = await rig(t), i = input(), f = frame([i]); queue(r, i);
    f.capacity.groups[0].slots = change === 'shrink' ? 2 : 1;
    r.send('decide', { frame: f });
    if (phase === 'checkout') {
      r.send('permit', { generation: 1, phase: 'launch', checkId: 500, appId: 900, frame: f });
      const x = { ...execution(i), heavyJobId: 1001 };
      r.send('bind', { generation: 1, execution: x,
        jobs: list([job(x, 1000, 'root'), job(x, 1001, 'heavy')]) });
    }
    const bad = structuredClone(f);
    bad.capacity.jobs = [{ id: 9999, runnerId: 19, generation: null }];
    if (change === 'shrink') bad.capacity.groups[0].slots = 1;
    const before = r.c.snapshot(T);
    assert.throws(() => r.send('permit', { generation: 1, phase,
      checkId: phase === 'launch' ? 500 : 501, appId: 900, frame: bad }), /Unknown/);
    assert.deepEqual(r.c.snapshot(T), before);
    // Fully reserved, feasible capacity still permits its already-reserved job.
    f.capacity.groups[0].slots = 1;
    r.send('permit', { generation: 1, phase, checkId: phase === 'launch' ? 500 : 501, appId: 900, frame: f });
  }
});

// A missing module is an expected red-phase failure, not silently skipped proof.
test('SQLite decisions are disabled, idempotent and survive a real close/reopen', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'admission-shadow-')); t.after(() => rmSync(dir, { recursive: true }));
  const file = join(dir, 'state.sqlite');
  const r = await rig(t, file); const i = input(); queue(r, i);
  const cmd = { id: 99, now: T, policy: 'shadow-v1', type: 'decide', frame: frame([i]) };
  const a = r.c.apply(cmd); assert.equal(a.status, 'Planned'); assert.equal(a.selected.length, 1);
  assert.deepEqual(a.effects, []); assert.deepEqual(r.c.apply(cmd), a);
  const { ShadowController } = await load();
  const reopened = new ShadowController(sqlite(r.db));
  assert.equal(reopened.snapshot(T).mode, 'DISABLED_SHADOW');
  assert.equal(reopened.snapshot(T).reservations.length, 1);
  const expected = reopened.snapshot(T); r.db.close();
  const second = new DatabaseSync(file); t.after(() => second.close());
  assert.deepEqual(new ShadowController(sqlite(second)).snapshot(T), expected);
});

test('reserve, intent, head/day charge and audit commit atomically, with no blind retry', async t => {
  const r = await rig(t), i = input(), x = execution(i); queue(r, i, x, 'recovery');
  const f = frame([i]); f.terminal = [terminal(x)];
  const original = r.c.snapshot(T);
  r.db.exec("CREATE TRIGGER fault BEFORE INSERT ON shadow_audit WHEN NEW.kind = 'decide' BEGIN SELECT RAISE(ABORT, 'fault'); END");
  assert.throws(() => r.send('decide', { frame: f }), /fault/);
  assert.deepEqual(r.c.snapshot(T), original);
  r.db.exec('DROP TRIGGER fault');
  const a = r.send('decide', { frame: f }); assert.equal(a.selected.length, 1);
  let s = r.c.snapshot(T); assert.equal(s.reservations[0].mutation, 'intent');
  assert.equal(Object.values(s.daily)[0], 1);
  r.send('lost', { generation: 1 }); r.send('tick', {}, T + 180001);
  s = r.c.snapshot(T + 180001); assert.equal(s.reservations.length, 1);
  assert.equal(s.reservations[0].mutation, 'unresolved');
  assert.equal(r.send('decide', { frame: frame([i], T + 300000) }, T + 300000).selected.length, 0);
  assert.throws(() => r.send('settle', { generation: 1, evidence: terminal(x, T + 300000),
    checkpoint: 'before_checkout', outcome: 'held' }, T + 300000), /Unknown/);
});

test('shared capacity counts overlapping labels and bound jobs once; physical unknown holds', async t => {
  const r = await rig(t), a = input(), b = input(50, 'Validate', EVO), c = input(51);
  queue(r, a); queue(r, b, execution(b, 200, 1, 2000)); queue(r, c, execution(c, 300, 1, 3000));
  let f = frame([a, b, c]); f.capacity.groups[0].slots = 1;
  assert.equal(r.send('decide', { frame: f }).selected.length, 1);
  f.capacity.jobs = [{ id: 1000, runnerId: 19, generation: 1 }];
  assert.equal(r.send('decide', { frame: f }).selected.length, 0);
  f.capacity.groups[0].slots = 2;
  assert.equal(r.send('decide', { frame: f }).selected.length, 1);
  assert.equal(r.c.snapshot(T).reservations.length, 2);
  assert.equal(r.send('decide', { frame: f }).selected.length, 0);
  const fresh = await rig(t); queue(fresh, a);
  f = frame([a]); f.capacity.groups = [];
  assert.equal(fresh.send('decide', { frame: f }).status, 'Unknown');
  f = frame([a]); f.capacity.jobs = [{ id: 9000, runnerId: 19, generation: null }];
  assert.equal(fresh.send('decide', { frame: f }).selected.length, 1);
});

test('stack ancestors, round robin and mandatory ordering survive controller restart', async t => {
  const r = await rig(t), a = input(), ai = input(42, 'AI'), child = { ...input(43), baseRef: 'pr-42' }, b = input(50, 'Validate', EVO);
  for (const [n, i] of [ai, child, b, a].entries()) queue(r, i, execution(i, 100 + n, 1, 1000 + n));
  const f = frame([ai, child, b, a]);
  const a1 = r.send('decide', { frame: f });
  assert.deepEqual(a1.selected.map(x => x.input.pr), [42, 50]);
  assert.equal(a1.selected[0].input.workload, 'Verify');
  const { ShadowController } = await load(); const copy = new ShadowController(sqlite(r.db));
  assert.deepEqual(copy.snapshot(T).cursor, r.c.snapshot(T).cursor);
  const s = r.c.snapshot(T); for (const o of s.reservations) { bill(r, o); r.send('settle', {
    generation: o.generation, evidence: { ...terminal(o.execution), items: terminal(o.execution).items.map(j => ({ ...j, workload: o.input.workload })) }, checkpoint: 'before_checkout', outcome: 'held' }); }
  // A completed before-checkout attempt becomes recovery, never another initial grant.
  const next = r.send('decide', { frame: f });
  assert.deepEqual(next.selected.map(x => [x.input.pr, x.input.workload]), [[42, 'AI'], [43, 'Verify']]);
});

test('ambiguous, cyclic, partial and stale graphs hold rather than invent stack roots', async t => {
  for (const alter of [f => { f.prs.complete = false; }, f => { f.prs.observedAt = T - 60001; },
    f => { f.prs.items[0].baseRef = f.prs.items[0].headRef; },
    f => { f.prs.items.push({ ...f.prs.items[0], id: 999, pr: 99 }, { ...f.prs.items[0], id: 998, pr: 98, headRef: 'child', baseRef: 'pr-42' }); },
    f => { f.inputs.items[0] = { ...f.inputs.items[0], baseSha: 'f'.repeat(40) }; }]) {
    const r = await rig(t), i = input(); queue(r, i); const f = frame([i]); alter(f);
    assert.equal(r.send('decide', { frame: f }).selected.length, 0);
  }
});

test('two-stage model permit allows root without heavy but fences late publication and duplicates', async t => {
  const r = await rig(t), i = input(); queue(r, i); const f = frame([i]); r.send('decide', { frame: f });
  r.send('permit', { generation: 1, phase: 'launch', checkId: 500, appId: 900, frame: f });
  assert.equal(r.c.snapshot(T).reservations[0].launch.execution.heavyJobId, null);
  const x = { ...execution(i), heavyJobId: 1001 };
  r.send('bind', { generation: 1, execution: x, jobs: list([job(x, 1000, 'root', 'success'), job(x, 1001, 'heavy', null, 'queued')]) });
  r.send('permit', { generation: 1, phase: 'checkout', checkId: 501, appId: 900, frame: frame([i], T + 119999) }, T + 119999);
  assert.throws(() => r.send('permit', { generation: 1, phase: 'checkout', checkId: 502, appId: 900, frame: frame([i], T + 119999) }, T + 119999), /Unknown/);
  const o = r.c.snapshot(T + 120001).reservations[0];
  r.send('consume', { generation: 1, evidence: list([o.checkout], T + 120001) }, T + 120001);
  assert.equal(r.c.snapshot(T + 120001).reservations[0].phase, 'Active');
  const late = await rig(t); queue(late, i); late.send('decide', { frame: f });
  late.send('permit', { generation: 1, phase: 'launch', checkId: 500, appId: 900, frame: f });
  late.send('tick', {}, T + 120000);
  assert.throws(() => late.send('permit', { generation: 1, phase: 'checkout', checkId: 501, appId: 900,
    frame: frame([i], T + 120000) }, T + 120000), /Unknown/);
  assert.equal(late.c.snapshot(T + 120000).reservations.length, 1);
  assert.equal(late.c.snapshot(T + 120000).reservations[0].phase, 'Held');
});

test('old active attempts and missing terminal pages cannot release; successful sibling retains original attribution', async t => {
  const r = await rig(t), i = input(); queue(r, i); r.send('decide', { frame: frame([i]) });
  const x = execution(i), e = terminal(x); e.run.attempt = 2; e.coveredAttempts = [1, 2];
  e.items.push(job(x, 9999, 'other', null, 'in_progress'));
  assert.throws(() => r.send('settle', { generation: 1, evidence: e, checkpoint: 'before_checkout', outcome: 'held' }), /Unknown/);
  const actual = { ...x, heavyJobId: 1001 };
  r.send('bind', { generation: 1, execution: actual, jobs: list([job(actual, 1000, 'root', 'success'), job(actual, 1001, 'heavy', 'success')]) });
  r.send('settle', { generation: 1, evidence: terminal(actual), checkpoint: 'after_checkout', outcome: 'success' });
  queue(r, i, execution(i, 200, 1, 2000));
  assert.equal(r.send('decide', { frame: frame([i]) }).selected.length, 0);
  assert.equal(r.c.snapshot(T).inputs[0].successExecution.heavyJobId, 1001);
});

test('genuine and ambiguous failure latches survive a second run and policy change', async t => {
  const r = await rig(t), i = input(); queue(r, i); r.send('decide', { frame: frame([i]) });
  r.send('settle', { generation: 1, evidence: terminal(execution(i)), checkpoint: 'unknown', outcome: 'held' });
  queue(r, i, execution(i, 222, 1, 2222));
  assert.equal(r.send('decide', { frame: frame([i]), policy: 'shadow-v2' }).selected.length, 0);
  assert.equal(r.c.snapshot(T).inputs[0].failureLatched, true);
});

test('pause, missing billing, rate and expiry suppress new rights while retaining issued rights and obligations', async t => {
  for (const alter of [f => { f.safety.paused = true; }, f => { f.safety.accounting.status = 'Unknown'; },
    f => { f.safety.rate.writesMinute = 10; }, f => { f.safety.activation.expiresAt = T; f.safety.activation.startedAt = T - 7 * 86400000; }]) {
    const r = await rig(t), i = input(); queue(r, i); const f = frame([i]); r.send('decide', { frame: f });
    r.send('permit', { generation: 1, phase: 'launch', checkId: 500, appId: 900, frame: f }); alter(f);
    assert.throws(() => r.send('permit', { generation: 1, phase: 'checkout', checkId: 501, appId: 900, frame: f }), /Unknown/);
    assert.equal(r.c.snapshot(T).reservations[0].launch.expiresAt, T + 120000);
    assert.equal(r.c.snapshot(T).reservations.length, 1);
  }
});

test('unknown/cross-date billing is durable and unexpected hosted usage stops model decisions', async t => {
  const r = await rig(t), i = input(); queue(r, i); r.send('decide', { frame: frame([i]) });
  r.send('ledger', { generation: 1, jobId: 1000, runnerType: 'hosted', createdAt: T - 1, startedAt: T - 1,
    completedAt: T, roundedMinutes: null });
  assert.equal(r.c.snapshot(T).accounting.status, 'Unknown');
  const b = input(50, 'Validate', EVO); queue(r, b, execution(b, 200, 1, 2000));
  assert.equal(r.send('decide', { frame: frame([i, b]) }).selected.length, 0);
  assert.equal(r.c.snapshot(T).accounting.unexpectedHostedJobs, 1);
});

test('corrupt/versioned durable state and clock rollback fail closed without resetting reservations', async t => {
  const r = await rig(t), i = input(); queue(r, i); r.send('decide', { frame: frame([i]) });
  assert.throws(() => r.send('tick', {}, T - 1), /Unknown/);
  r.db.exec("UPDATE shadow_state SET body = '{\"version\":999}'");
  assert.throws(() => r.c.snapshot(T), /Unknown/);
  assert.throws(() => r.send('tick'), /Unknown/);
  assert.equal(r.db.prepare('SELECT COUNT(*) AS n FROM shadow_audit').get().n, 2);
});

function ownerCheck(i, now, rootId = 2000, role = 'root') {
  const x = execution(i, 100, 2, rootId);
  return { expected: { input: i, rootInputs: [i] }, observation: {
    attempt: { repoId: i.repoId, runId: 100, number: 2, triggeringActorId: 37964907,
      triggeringActorType: 'User', input: i, observedAt: now },
    jobs: list([job(x, rootId, role)], now), refs: { input: i, observedAt: now },
    permission: { actorId: 37964907, value: 'admin', observedAt: now } } };
}

test('owner intent dedup, App inheritance and three race-inclusive reentries never reset clocks or bounds', async t => {
  const r = await rig(t), i = input(); queue(r, i);
  const proof = ownerCheck(i, T); r.send('owner', proof);
  let s = r.c.snapshot(T); assert.equal(s.requests.length, 1); assert.equal(s.inputs[0].readyAt, T - 1000);
  assert.equal(s.inputs[0].execution.rootJobId, 2000);
  for (let n = 0; n < 3; n++) {
    const now = T + n * 300000, f = frame([i], now); f.ownerChecks = [ownerCheck(i, now)];
    s = r.c.snapshot(now); f.terminal = [terminal(s.inputs[0].execution, now)];
    const a = r.send('decide', { frame: f }, now); assert.equal(a.selected.length, 1);
    r.send('lost', { generation: n + 1 }, now);
    const x = { ...s.inputs[0].execution, attempt: s.inputs[0].execution.attempt + 1,
      rootJobId: 3000 + n, generation: n + 1 };
    r.send('bind', { generation: n + 1, execution: x, appId: 900,
      jobs: list([job(x, x.rootJobId, 'root')], now) }, now);
    bill(r, { generation: n + 1, execution: x }, now);
    r.send('settle', { generation: n + 1, evidence: terminal(x, now), checkpoint: 'before_checkout', outcome: 'held' }, now);
    queue(r, i, x, 'recovery', now);
    r.send('owner', ownerCheck(i, now), now);
    assert.equal(r.c.snapshot(now).inputs[0].intentCreatedAt, T);
  }
  const now = T + 900000, f = frame([i], now); f.ownerChecks = [ownerCheck(i, now)];
  f.terminal = [terminal(r.c.snapshot(now).inputs[0].execution, now)];
  assert.equal(r.send('decide', { frame: f }, now).selected.length, 0);
  s = r.c.snapshot(now); assert.equal(s.requests[0].reentries, 3);
  assert.equal(Object.values(s.daily)[0], 3); assert.equal(s.requests.length, 1);
});

test('heavy-only owner rerun creates no request; permission loss and forged binding identity hold', async t => {
  const r = await rig(t), i = input(); queue(r, i);
  r.send('owner', ownerCheck(i, T, 2001, 'heavy'));
  assert.equal(r.c.snapshot(T).requests.length, 0);
  r.send('owner', ownerCheck(i, T));
  let f = frame([i]); const proof = ownerCheck(i, T); proof.observation.permission.value = 'read';
  f.ownerChecks = [proof]; f.terminal = [terminal(execution(i, 100, 2, 2000))];
  assert.equal(r.send('decide', { frame: f }).selected.length, 0);
  f.ownerChecks = [ownerCheck(i, T)]; r.send('decide', { frame: f });
  const x = { ...execution(i, 100, 3, 3000), generation: 1 };
  assert.throws(() => r.send('bind', { generation: 1, execution: x, appId: 901, expectedAppId: 901,
    jobs: list([job(x, 3000, 'root')]) }), /Unknown/);
  assert.equal(r.c.snapshot(T).reservations[0].mutation, 'intent');
});

test('midnight and DST billing retains unallocated rounded totals as Unknown', async t => {
  for (const [start, end] of [['2026-11-21T21:59:59Z', '2026-11-21T22:00:01Z'],
    ['2026-03-26T21:59:59Z', '2026-03-27T01:00:01Z'], ['2026-10-24T20:59:59Z', '2026-10-25T01:00:01Z']]) {
    const r = await rig(t), i = input(); queue(r, i); r.send('decide', { frame: frame([i]) });
    // Record historical, authoritative billing clocks; these are not a scheduling clock reset.
    const a = Date.parse(start), b = Date.parse(end), now = Math.max(T, b);
    r.send('ledger', { generation: 1, jobId: 1000, runnerType: 'hosted', createdAt: a,
      startedAt: a, completedAt: b, roundedMinutes: Math.ceil((b - a) / 60000) }, now);
    const s = r.c.snapshot(now); assert.equal(s.ledger[0].day, null);
    assert.equal(s.accounting.status, 'Unknown'); assert.equal(s.accounting.hostedMinutesTotal, null);
  }
});

test('terminal jobs with missing accounting stay Unknown until authoritative lifecycle is supplied', async t => {
  const r = await rig(t), i = input(); queue(r, i); r.send('decide', { frame: frame([i]) });
  r.send('settle', { generation: 1, evidence: terminal(execution(i)), checkpoint: 'before_checkout', outcome: 'held' });
  assert.equal(r.c.snapshot(T).ledger.length, 1);
  const b = input(50, 'Validate', EVO); queue(r, b, execution(b, 200, 1, 2000));
  assert.equal(r.send('decide', { frame: frame([i, b]) }).selected.length, 0);
  bill(r, { generation: 1, execution: execution(i) });
  assert.equal(r.send('decide', { frame: frame([i, b]) }).selected.length, 1);
});

function bill(r, o, now = T) {
  for (const jobId of [o.execution.rootJobId, o.execution.heavyJobId].filter(Boolean)) r.send('ledger', {
    generation: o.generation, jobId, runnerType: 'self-hosted', createdAt: now,
    startedAt: now, completedAt: now, roundedMinutes: 0 }, now);
}

test('owner/App race with extra actual root never binds a generation or frees its intent', async t => {
  const r = await rig(t), i = input(), x = execution(i); queue(r, i, x, 'recovery');
  const f = frame([i]); f.terminal = [terminal(x)]; r.send('decide', { frame: f });
  const actual = { ...x, attempt: 2, rootJobId: 2000 };
  assert.throws(() => r.send('bind', { generation: 1, execution: actual, appId: 900,
    jobs: list([job(actual, 2000, 'root'), job(actual, 2010, 'root', 'failure', 'completed', 'Storybook')]) }), /Unknown/);
  assert.equal(r.c.snapshot(T).reservations[0].mutation, 'intent');
});

test('executable partial Verify then Storybook recovery preserves successful sibling original jobs', async t => {
  const fixture = require('./fixtures/ci-admission-shadow.json'); assert.equal(fixture.version, 1);
  const r = await rig(t), inputs = fixture.partialRecovery.map(e => input(42, e.workload));
  for (const [n, i] of inputs.entries()) r.send('queue', { input: i, execution: execution(i, 100, 1,
    fixture.partialRecovery[n].originRoot), readyAt: T - 2000 + n * 1000, mandatory: true, mode: 'recovery' });
  let previousJobs = fixture.partialRecovery.map((e, n) => job(execution(inputs[n]), e.originRoot, 'root', 'failure', 'completed', e.workload));
  for (const [n, step] of fixture.partialRecovery.entries()) {
    const i = inputs[n], now = T + n * 1000, f = frame(inputs, now);
    const origin = execution(i, 100, step.attempt - 1, step.originRoot);
    // Storybook's original root remains attempt 1, even when latest run attempt is 2.
    if (n) origin.attempt = 1;
    const evidence = { ...terminal(origin, now), items: previousJobs, coveredAttempts: Array.from({ length: step.attempt - 1 }, (_, k) => k + 1) };
    evidence.run.attempt = step.attempt - 1; f.terminal = [evidence];
    const a = r.send('decide', { frame: f }, now);
    assert.deepEqual(a.selected.map(o => o.input.workload), [step.workload]);
    // The next attempt is determined by the reconciled WHOLE run, not the old
    // omitted root's original attempt. This is central to partial recovery.
    const actual = { ...execution(i, 100, step.attempt, step.root), heavyJobId: step.heavy, generation: step.generation };
    const jobs = [job(actual, step.root, 'root', 'success', 'completed', step.workload), job(actual, step.heavy, 'heavy', 'success', 'completed', step.workload)];
    r.send('bind', { generation: step.generation, execution: actual, appId: 900, jobs: list(jobs, now) }, now);
    bill(r, { generation: step.generation, execution: actual }, now);
    const all = { ...terminal(actual, now), items: [...previousJobs, ...jobs] };
    r.send('settle', { generation: step.generation, evidence: all, checkpoint: 'after_checkout', outcome: 'success' }, now);
    previousJobs.push(...jobs);
  }
  const s = r.c.snapshot(T + 1000);
  assert.deepEqual(s.inputs.map(i => [i.input.workload, i.successExecution.attempt, i.successExecution.heavyJobId]),
    [['Verify', 2, 2001], ['Storybook', 3, 3001]]);
  assert.equal(s.reservations.length, 0); assert.deepEqual(s.effects, []);
});

test('conflicting owner or whole-run evidence is Unknown rather than selecting a favorable observation', async t => {
  const r = await rig(t), i = input(); queue(r, i); r.send('owner', ownerCheck(i, T));
  const f = frame([i]); const good = ownerCheck(i, T), bad = ownerCheck(i, T);
  bad.observation.permission.value = 'read'; f.ownerChecks = [good, bad];
  const e = terminal(execution(i, 100, 2, 2000)); f.terminal = [e];
  assert.equal(r.send('decide', { frame: f }).selected.length, 0);
  f.ownerChecks = [good]; f.terminal.push({ ...e, complete: false });
  assert.equal(r.send('decide', { frame: f }).selected.length, 0);
});

test('latest safety hold replaces an earlier planned decision; unobserved accounting has no zero total', async t => {
  const r = await rig(t), i = input(); queue(r, i); r.send('decide', { frame: frame([i]) });
  const f = frame([i]); f.safety.paused = true; r.send('decide', { frame: f });
  assert.equal(r.c.snapshot(T).lastDecision.reason, 'Pilot inactive');
  assert.equal(r.c.snapshot(T).accounting.hostedMinutesTotal, null);
});

test('branched stack topology always admits the pending ancestor before its older descendant', async t => {
  const r = await rig(t), a = { ...input(11), baseRef: 'pr-10' },
    b = { ...input(12), baseRef: 'pr-11' }, sibling = { ...input(13), baseRef: 'pr-10' };
  for (const [n, i] of [b, sibling, a].entries()) r.send('queue', { input: i,
    execution: execution(i, 100 + i.pr, 1, 1000 + i.pr), mode: 'initial', mandatory: true,
    readyAt: T - 3000 + n * 1000 });
  const f = frame([b, sibling, a]); f.capacity.groups[0].slots = 1;
  f.prs.items.push({ id: 999, repoId: UI, pr: 10, headRef: 'pr-10', baseRef: 'main', open: true, draft: false, refsKnown: true });
  const result = r.send('decide', { frame: f }); assert.equal(result.selected.length, 1);
  assert.equal(result.selected[0].input.pr, 13); // oldest eligible stack frontier
});

test('same checkout check cannot extend its persisted right by changing issue/expiry clocks', async t => {
  const r = await rig(t), i = input(); queue(r, i); const f = frame([i]); r.send('decide', { frame: f });
  r.send('permit', { generation: 1, phase: 'launch', checkId: 500, appId: 900, frame: f });
  const x = { ...execution(i), heavyJobId: 1001 };
  r.send('bind', { generation: 1, execution: x, jobs: list([job(x, 1000, 'root', 'success'), job(x, 1001, 'heavy', null, 'queued')]) });
  r.send('permit', { generation: 1, phase: 'checkout', checkId: 501, appId: 900, frame: f });
  const check = { ...r.c.snapshot(T).reservations[0].checkout, issuedAt: T + 119999, expiresAt: T + 239999 };
  assert.throws(() => r.send('consume', { generation: 1, evidence: list([check], T + 180000) }, T + 180000), /Unknown/);
  assert.equal(r.c.snapshot(T + 180000).reservations[0].phase, 'Bound');
});

test('observed unbound actual heavy cannot disappear from terminal obligations or accounting', async t => {
  const r = await rig(t), i = input(); queue(r, i); r.send('decide', { frame: frame([i]) });
  const x = { ...execution(i), heavyJobId: 1001 }, e = terminal(x);
  assert.throws(() => r.send('settle', { generation: 1, evidence: e, checkpoint: 'unknown', outcome: 'failure' }), /Unknown/);
  assert.equal(r.c.snapshot(T).reservations.length, 1);
  r.send('bind', { generation: 1, execution: x, jobs: list(e.items) });
  r.send('settle', { generation: 1, evidence: e, checkpoint: 'unknown', outcome: 'failure' });
  assert.deepEqual(r.c.snapshot(T).ledger.map(j => j.jobId), [1000, 1001]);
  bill(r, { generation: 1, execution: x });
  assert.equal(r.c.snapshot(T).accounting.status, 'Known');
});

test('initial native binding accepts legitimate sibling roots without treating them as an App race', async t => {
  const r = await rig(t), i = input(); queue(r, i); r.send('decide', { frame: frame([i]) });
  const x = { ...execution(i), heavyJobId: 1001 };
  r.send('bind', { generation: 1, execution: x, jobs: list([job(x, 1000, 'root'),
    job(x, 1001, 'heavy'), job(x, 1010, 'root', 'failure', 'completed', 'Storybook')]) });
  assert.equal(r.c.snapshot(T).reservations[0].execution.heavyJobId, 1001);
});

test('audit records canonical targets and model actor for each durable mutation, never arbitrary command text', async t => {
  const r = await rig(t), i = input(); queue(r, i); r.send('decide', { frame: frame([i]), body: 'must-not-retain' });
  const rows = r.db.prepare('SELECT kind, body FROM shadow_audit ORDER BY id').all();
  assert.equal(JSON.parse(rows[0].body).targets[0].input.pr, 42);
  assert.equal(JSON.parse(rows[1].body).targets[0].mutation, 'none');
  assert.equal(JSON.parse(rows[1].body).actor.kind, 'shadow-model');
  assert.equal(JSON.stringify(rows).includes('must-not-retain'), false);
});

test('partial Unknown billing reconciles monotonically while conflicting known facts stay rejected', async t => {
  for (const partial of [{ runnerType: 'self-hosted', roundedMinutes: null }, { runnerType: 'unknown', roundedMinutes: 0 }]) {
    const r = await rig(t), i = input(); queue(r, i); r.send('decide', { frame: frame([i]) });
    const known = { generation: 1, jobId: 1000, runnerType: 'self-hosted', createdAt: T - 1,
      startedAt: T - 1, completedAt: T, roundedMinutes: 0 };
    r.send('ledger', { ...known, ...partial });
    assert.equal(r.c.snapshot(T).accounting.status, 'Unknown');
    r.send('ledger', known); assert.equal(r.c.snapshot(T).accounting.status, 'Known');
    assert.throws(() => r.send('ledger', { ...known, runnerType: 'hosted' }), /Unknown/);
  }
});

test('unmapped actual heavy from a later manual attempt prevents release of the older obligation', async t => {
  const r = await rig(t), i = input(); queue(r, i); r.send('decide', { frame: frame([i]) });
  const x = execution(i), e = terminal(x); e.run.attempt = 2; e.coveredAttempts = [1, 2];
  e.items.push(job({ ...x, attempt: 2 }, 2001, 'heavy', 'failure'));
  assert.throws(() => r.send('settle', { generation: 1, evidence: e, checkpoint: 'before_checkout', outcome: 'held' }), /Unknown/);
  assert.equal(r.c.snapshot(T).reservations.length, 1);
});

test('unused malformed command fields cannot export arbitrary upstream text through audit clocks', async t => {
  const r = await rig(t);
  r.send('tick', { jobs: { observedAt: { rawBody: 'must-not-retain', padding: 'X'.repeat(1000) } } });
  const audit = r.db.prepare('SELECT body FROM shadow_audit').get().body;
  assert.equal(audit.includes('must-not-retain'), false);
  assert.equal(JSON.parse(audit).evidenceAt, null);
});

test('a new activation identity cannot revive a prior simulated reservation', async t => {
  const r = await rig(t), i = input(), f = frame([i]); queue(r, i); r.send('decide', { frame: f });
  f.safety.activation.id = 'different-synthetic-authority';
  assert.throws(() => r.send('permit', { generation: 1, phase: 'launch', checkId: 500, appId: 900, frame: f }), /Unknown/);
  assert.equal(r.c.snapshot(T).reservations.length, 1);
});

test('conflicting current inputs and duplicate actual initial roots cannot acquire two generations', async t => {
  const r = await rig(t), a = input(), b = input(43);
  queue(r, a); queue(r, b, execution(b));
  assert.equal(r.send('decide', { frame: frame([a, b]) }).selected.length, 1);
  const r2 = await rig(t); queue(r2, a);
  assert.equal(r2.send('decide', { frame: frame([a, { ...a, digest: 'e'.repeat(64) }]) }).status, 'Unknown');
});

test('new reservations fit every retained repository and remain launchable in split groups', async t => {
  for (const [smallRepo, largeRepo] of [[UI, EVO], [EVO, UI]]) {
    const r = await rig(t), a = input(42, 'Verify', smallRepo), b = input(50, 'Validate', largeRepo);
    const x = execution(a), y = execution(b, 200, 1, 2000);
    r.send('queue', { input: a, execution: x, readyAt: T - 2000, mandatory: true, mode: 'initial' });
    queue(r, b, y);
    const f = frame([a, b]);
    f.capacity.groups = [{ id: 1, slots: 1 }, { id: 2, slots: 2 }];
    f.capacity.runners.forEach((runner, n) => {
      runner.groupId = n === 0 ? 1 : 2; runner.repoIds = [n === 0 ? smallRepo : largeRepo];
    });
    const decision = r.send('decide', { frame: f });
    assert.deepEqual(decision.selected.map(q => q.input.repoId), [smallRepo]);
    assert.equal(r.c.snapshot(T).reservations.length, 1);
    assert.equal(r.send('decide', { frame: f }).selected.length, 0);
    r.send('permit', { generation: 1, phase: 'launch', checkId: 500, appId: 900, frame: f });
    const bound = { ...x, heavyJobId: 1001 };
    r.send('bind', { generation: 1, execution: bound, jobs: list([
      job(bound, x.rootJobId, 'root', 'success'), job(bound, 1001, 'heavy', null, 'queued')]) });
    r.send('permit', { generation: 1, phase: 'checkout', checkId: 501, appId: 900, frame: f });
    assert.equal(r.c.snapshot(T).reservations[0].phase, 'Bound');
  }
});

test('a repository with no retained work does not limit another repository eligible for two slots', async t => {
  const r = await rig(t), a = input(50, 'Validate', EVO), b = input(51, 'Validate', EVO);
  queue(r, a); queue(r, b, execution(b, 200, 1, 2000));
  const f = frame([a, b]);
  f.capacity.groups = [{ id: 1, slots: 1 }, { id: 2, slots: 2 }];
  f.capacity.runners.forEach((runner, n) => {
    runner.groupId = n === 0 ? 1 : 2; runner.repoIds = [n === 0 ? UI : EVO];
  });
  assert.equal(r.send('decide', { frame: f }).selected.length, 2);
});

test('valid Git branch refs on unrelated draft PRs do not suppress admission', async t => {
  for (const headRef of ['feature/ci+metrics', `feature/${'x'.repeat(96)}`, 'feature/שלום',
    '@', 'feature/x.LOCK', 'feature./child', "feature/quote'and$dollar;plus+"]) {
    assert.equal(spawnSync('git', ['check-ref-format', '--branch', headRef]).status, 0, headRef);
    const r = await rig(t), i = input(); queue(r, i);
    const f = frame([i]); f.prs.items.push({ id: 999, repoId: EVO, pr: 99,
      headRef, baseRef: 'main', open: true, draft: true, refsKnown: true });
    const decision = r.send('decide', { frame: f });
    assert.equal(decision.status, 'Planned', headRef);
    assert.equal(decision.selected.length, 1, headRef);
  }
});

test('valid branch refs still link the exact same-repository stack ancestor', async t => {
  const r = await rig(t), parent = input(42), child = { ...input(43), baseRef: 'feature/ci+metrics' };
  queue(r, child, execution(child, 200, 1, 2000)); queue(r, parent);
  const f = frame([child, parent]);
  f.prs.items.find(p => p.pr === 42).headRef = child.baseRef;
  f.capacity.groups[0].slots = 1;
  const decision = r.send('decide', { frame: f });
  assert.deepEqual(decision.selected.map(q => q.input.pr), [42]);
});

test('malformed branch refs still make complete graph evidence Unknown', async t => {
  for (const ref of ['', 'HEAD', '-leading', '/leading', 'trailing/', 'feature//child',
    'feature/.hidden', 'feature/x.lock', 'feature/x.', 'feature/two..dots', 'space name',
    'feature/ref@{1}', 'feature/tilde~', 'feature/caret^', 'feature/colon:', 'feature/question?',
    'feature/star*', 'feature/bracket[', 'feature/back\\slash', 'feature/tab\t', 'feature/del\u007f']) {
    assert.notEqual(spawnSync('git', ['check-ref-format', '--branch', ref]).status, 0, ref);
    for (const field of ['headRef', 'baseRef']) {
      const r = await rig(t), i = input(); queue(r, i);
      const f = frame([i]); f.prs.items.push({ id: 999, repoId: EVO, pr: 99,
        headRef: 'unrelated', baseRef: 'main', [field]: ref, open: true, draft: true, refsKnown: true });
      assert.equal(r.send('decide', { frame: f }).status, 'Unknown', `${field}: ${ref}`);
      assert.equal(r.c.snapshot(T).reservations.length, 0);
    }
  }
});
