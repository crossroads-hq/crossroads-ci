const { test } = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const { mkdtempSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
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

// Synthetic evidence only; no enrollment, HTTP, token or live executor.
function writerFrame(i = input(), now = T) {
  const f = frame([i], now);
  f.enrollments = { ...list([{ repoId: i.repoId, repository: 'crossroads-hq/crossroads-ui',
    workflowId: 50, schedulerAppId: 900, workflow: i.workflow, digest: i.digest,
    root: { key: 'admission-verify', name: 'Admission Verify' },
    heavy: { key: 'verify', name: 'Verify' }, workload: i.workload, capability: 'fast',
    files: [{ path: i.workflow, sha256: 'e'.repeat(64) }] }], now), repoIds: [UI, EVO] };
  f.gates = { ...list([UI, EVO].map(id => ({ id, appId: 15368 })), now), repoIds: [UI, EVO] };
  return f;
}
const checks = (i, x, phase, items = [], now = T) => ({ ...list(items, now),
  input: i, execution: x, phase });
async function reserved(t, mode = 'initial', file) {
  const r = await rig(t, file), i = input(), x = execution(i), f = writerFrame(i);
  queue(r, i, x, mode); if (mode === 'recovery') f.terminal = [terminal(x)];
  r.send('writer-reserve', { frame: f }); return { ...r, i, x, f };
}
const prepare = (r, phase = 'launch', now = T, f = r.f) => r.send('writer-prepare', {
  generation: 1, phase, frame: f, checks: checks(r.i, r.c.snapshot(now).reservations[0].execution, phase, [], now) }, now);
const row = (r, index = 0, now = T) => r.c.snapshot(now).writer.writes[index];
const raw = (w, id = 500) => ({ id, app: { id: 900 }, head_sha: w.request.body.head_sha || 'c'.repeat(40),
  name: w.request.body.name, external_id: w.request.body.external_id,
  status: w.request.body.status, conclusion: w.request.body.conclusion ?? null,
  output: w.request.body.output });
const reconcile = (r, w, items, now = T) => r.send('writer-reconcile', { writeId: w.id,
  checks: checks(r.i, w.execution, w.phase, items, now) }, now);
function create(r, phase = 'launch', id = 500, now = T, f = r.f) {
  prepare(r, phase, now, f); const w = row(r, r.c.snapshot(now).writer.writes.length - 1, now);
  r.send('writer-fence', { writeId: w.id, frame: f }, now);
  reconcile(r, w, [raw(w, id)], now); return w;
}
function publish(r, phase = 'launch', id = 500, now = T, f = r.f) {
  r.send('writer-prepare', { generation: 1, phase, frame: f }, now);
  const w = row(r, r.c.snapshot(now).writer.writes.length - 1, now);
  r.send('writer-fence', { writeId: w.id, frame: f }, now);
  reconcile(r, w, [raw(w, id)], now); return w;
}

test('writer reserve and targeted rerun intent commit in one SQLite transaction', async t => {
  const r = await rig(t), i = input(), x = execution(i), f = writerFrame(i);
  queue(r, i, x, 'recovery'); f.terminal = [terminal(x)];
  const before = r.c.snapshot(T);
  r.db.exec("CREATE TRIGGER fault BEFORE INSERT ON shadow_audit WHEN NEW.kind = 'writer-reserve' BEGIN SELECT RAISE(ABORT, 'fault'); END");
  assert.throws(() => r.send('writer-reserve', { frame: f }), /fault/);
  assert.deepEqual(r.c.snapshot(T), before); r.db.exec('DROP TRIGGER fault');
  r.send('writer-reserve', { frame: f });
  const s = r.c.snapshot(T), w = s.writer.writes[0];
  assert.equal(s.writer.mode, 'DISABLED'); assert.deepEqual(s.effects, []);
  assert.equal(s.reservations[0].mutation, 'intent'); assert.equal(Object.values(s.daily)[0], 1);
  assert.equal(w.state, 'intent'); assert.equal(w.request.method, 'POST');
  assert.equal(w.request.path, '/repos/crossroads-hq/crossroads-ui/actions/jobs/1000/rerun');
  assert.deepEqual(w.request.body, { enable_debug_logging: false });
});

test('initial check creation is inert until assigned ID is reconciled and publication is separately fenced', async t => {
  const r = await reserved(t); assert.equal(r.c.snapshot(T).writer.writes.length, 0);
  const w = create(r); assert.equal(w.request.body.status, 'in_progress');
  assert.equal(w.request.body.output.text, undefined); assert.equal(row(r).checkId, 500);
  assert.equal(r.c.snapshot(T).reservations[0].launch, null);
  const p = publish(r); assert.equal(p.request.method, 'PATCH');
  assert.equal(p.request.path, '/repos/crossroads-hq/crossroads-ui/check-runs/500');
  const payload = JSON.parse(p.request.body.output.text);
  assert.equal(payload.id, 500); assert.equal(payload.protocol, 'hq-085-permit-v1');
  assert.equal(r.c.snapshot(T).reservations[0].launch.id, 500);
  assert.equal(r.c.snapshot(T).writer.writes.length, 2);
  assert.throws(() => prepare(r), /Unknown/);
});

test('lost create acknowledgement survives reopen; empty partial duplicate or forged evidence cannot rewrite', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'admission-writer-')); t.after(() => rmSync(dir, { recursive: true }));
  const file = join(dir, 'state.sqlite'), r = await reserved(t, 'initial', file);
  prepare(r); const w = row(r); r.send('writer-fence', { writeId: 1, frame: r.f });
  const { ShadowController } = await load(); r.db.close();
  const db = new DatabaseSync(file); t.after(() => db.close()); r.c = new ShadowController(sqlite(db));
  let seq = 100; r.send = (type, payload = {}, now = T) => r.c.apply({ id: ++seq, now, policy: 'writer-v1', type, ...payload });
  assert.equal(row(r).state, 'unresolved');
  assert.throws(() => prepare(r), /Unknown/);
  assert.throws(() => r.send('writer-fence', { writeId: 1, frame: r.f }), /Unknown/);
  for (const items of [[], [raw(w), raw(w, 501)], [{ ...raw(w), app: { id: 15368 } }],
    [{ ...raw(w), head_sha: 'f'.repeat(40) }], [{ ...raw(w), external_id: 'hq-085/v1/2/launch' }]]) {
    assert.throws(() => reconcile(r, w, items), /Unknown/);
    assert.equal(row(r).state, 'unresolved');
  }
  assert.throws(() => r.send('writer-reconcile', { writeId: 1, checks: { ...checks(r.i, r.x, 'launch', [raw(w)]), complete: false } }), /Unknown/);
  reconcile(r, w, [raw(w)]); assert.equal(row(r).state, 'confirmed');
});

test('rerun 2xx is not confirmation; exact App next attempt binds and races retain obligations', async t => {
  const r = await reserved(t, 'recovery'); r.send('writer-fence', { writeId: 1, frame: r.f });
  assert.throws(() => r.send('writer-reconcile', { writeId: 1, httpStatus: 201 }), /Unknown/);
  assert.equal(r.c.snapshot(T).reservations[0].mutation, 'unresolved');
  const x = { ...r.x, attempt: 2, rootJobId: 2000 };
  const payload = { writeId: 1, appId: 900, input: r.i, execution: x,
    jobs: list([job(x, 2000, 'root')]) };
  assert.throws(() => r.send('writer-bind', { ...payload, appId: 901 }), /Unknown/);
  assert.throws(() => r.send('writer-bind', { ...payload, execution: { ...x, attempt: 3 } }), /Unknown/);
  r.send('writer-bind', payload);
  assert.equal(row(r).state, 'confirmed'); assert.equal(r.c.snapshot(T).reservations[0].execution.rootJobId, 2000);
  assert.throws(() => r.send('writer-bind', payload), /Unknown/);
});

test('every new write rechecks refs enrollment provenance protected gates rate and retained capacity', async t => {
  for (const mutate of [f => { f.inputs.items[0].baseSha = 'f'.repeat(40); },
    f => { f.enrollments.items[0].schedulerAppId = 901; }, f => { f.gates.items[0].appId = 900; },
    f => { f.safety.paused = true; }, f => { f.safety.rate.headroom = 0.24; },
    f => { f.safety.rate.writesMinute = 9; }, f => { f.safety.accounting.status = 'Unknown'; },
    f => { f.capacity.groups[0].slots = 1; f.capacity.jobs = [{ id: 9999, runnerId: 19, generation: null }]; }]) {
    const r = await reserved(t), bad = structuredClone(r.f); mutate(bad);
    assert.throws(() => prepare(r, 'launch', T, bad), /Unknown/);
    assert.equal(r.c.snapshot(T).writer.writes.length, 0); assert.equal(r.c.snapshot(T).reservations.length, 1);
  }
  const r = await reserved(t); prepare(r); const bad = structuredClone(r.f); bad.safety.revoked = true;
  assert.throws(() => r.send('writer-fence', { writeId: 1, frame: bad }), /Unknown/);
  assert.equal(row(r).state, 'intent');
});

test('checkout publishes strictly before launch deadline; late receipt cannot renew its fixed clocks', async t => {
  const r = await reserved(t); create(r); publish(r);
  const x = { ...r.x, heavyJobId: 1001 };
  r.send('writer-bind-heavy', { generation: 1, execution: x,
    jobs: list([job(x, 1000, 'root'), job(x, 1001, 'heavy')]) });
  const late = T + 120000, f = writerFrame(r.i, late);
  assert.throws(() => prepare(r, 'checkout', late, f), /Unknown/);
  assert.equal(r.c.snapshot(late).reservations[0].launch.expiresAt, late);
});

test('pause rollback expiry and unresolved publication retain all obligations and history', async t => {
  const r = await reserved(t); create(r);
  r.send('writer-prepare', { generation: 1, phase: 'launch', frame: r.f });
  const w = row(r, 1); r.send('writer-fence', { writeId: 2, frame: r.f });
  r.send('writer-stop');
  assert.throws(() => prepare(r), /Unknown/);
  assert.throws(() => r.send('settle', { generation: 1, evidence: terminal(r.x), checkpoint: 'before_checkout', outcome: 'held' }), /Unknown/);
  reconcile(r, w, [raw(w)]); r.send('tick', {}, T + 180001);
  const s = r.c.snapshot(T + 180001); assert.equal(s.writer.stopped, true);
  assert.equal(s.reservations.length, 1); assert.equal(s.writer.writes[1].state, 'confirmed');
  assert.equal(s.reservations[0].launch.expiresAt, T + 120000); assert.deepEqual(s.effects, []);
});

test('prepared rights cannot be dispatched late and command ID collisions cannot replay different work', async t => {
  const r = await reserved(t); prepare(r);
  assert.throws(() => r.send('writer-fence', { writeId: 1, frame: writerFrame(r.i, T + 5001) }, T + 5001), /Unknown/);
  const cmd = { id: 999, type: 'writer-stop', policy: 'writer-v1', now: T + 5001 };
  r.c.apply(cmd); assert.deepEqual(r.c.apply(cmd).effects, []);
  assert.throws(() => r.c.apply({ ...cmd, type: 'writer-reserve' }), /Unknown/);
});


test('corrupt persisted request method path body identity and clocks fail before any fence', async t => {
  for (const change of [w => { w.request.path = '/repos/crossroads-hq/crossroads-ui/issues/1'; },
    w => { w.request.method = 'PATCH'; }, w => { w.request.body.name = 'PR Validation'; },
    w => { w.input.head = 'f'.repeat(40); }, w => { w.execution.rootJobId = 1002; },
    w => { w.preparedAt = T + 1; }, w => { w.phase = 'other'; }]) {
    const r = await reserved(t); prepare(r); const s = JSON.parse(r.db.prepare('SELECT body FROM shadow_state WHERE id = 1').get().body);
    change(s.writer.writes[0]); r.db.prepare('UPDATE shadow_state SET body = ? WHERE id = 1').run(JSON.stringify(s));
    const { ShadowController } = await load();
    assert.throws(() => new ShadowController(sqlite(r.db)), /Unknown/);
    assert.throws(() => r.send('writer-fence', { writeId: 1, frame: r.f }), /Unknown/);
  }
});

test('inert pending name is invisible to the pinned permit-name parser', async t => {
  const r = await reserved(t); const w = create(r);
  assert.equal(w.request.body.name, 'CI admission pending / launch / Verify');
  assert.notEqual(w.request.body.name, 'CI admission launch / Verify');
  assert.equal(publish(r).request.body.name, 'CI admission launch / Verify');
});


test('fresh rate observations cannot erase older undispatched write reservations', async t => {
  const r = await reserved(t); prepare(r);
  const f = writerFrame(r.i, T + 1); f.safety.rate.writesMinute = 8;
  assert.throws(() => r.send('writer-fence', { writeId: 1, frame: f }, T + 1), /Unknown/);
  assert.equal(row(r, 0, T + 1).state, 'intent');
});

test('checkout success observed after launch deadline remains unresolved and cannot renew clocks', async t => {
  const r = await reserved(t); create(r); publish(r);
  const x = { ...r.x, heavyJobId: 1001 };
  r.send('writer-bind-heavy', { generation: 1, execution: x,
    jobs: list([job(x, 1000, 'root'), job(x, 1001, 'heavy')]) });
  const at = T + 119999, f = writerFrame(r.i, at); create(r, 'checkout', 501, at, f);
  r.send('writer-prepare', { generation: 1, phase: 'checkout', frame: f }, at);
  const w = row(r, 3, at); r.send('writer-fence', { writeId: w.id, frame: f }, at);
  assert.throws(() => reconcile(r, w, [{ ...raw(w, 501), completed_at: new Date(T + 120001).toISOString() }], T + 120001), /Unknown/);
  const s = r.c.snapshot(T + 120001); assert.equal(s.reservations[0].checkout, null);
  assert.equal(s.writer.writes[3].state, 'unresolved'); assert.equal(s.reservations.length, 1);
});

test('writer audit records targeted deltas source windows identity and remaining bounds', async t => {
  const r = await reserved(t); prepare(r);
  const a = JSON.parse(r.db.prepare("SELECT body FROM shadow_audit WHERE kind = 'writer-prepare'").get().body);
  assert.equal(a.writer.writes.length, 1); assert.equal(a.writer.writes[0].generation, 1);
  assert.equal(a.writer.appId, 900); assert.equal(a.writer.sources.rate.observedAt, T);
  assert.equal(a.writer.sources.rate.complete, true); assert.equal(a.writer.bounds.headroom, 1);
  assert.equal(a.writer.bounds.recoveriesDayRemaining, 3);
  assert.equal(a.targets[0].input.head, r.i.head);
});

test('losing writer state cannot silently recreate durable write authority', async t => {
  const r = await reserved(t); prepare(r);
  const s = JSON.parse(r.db.prepare('SELECT body FROM shadow_state WHERE id = 1').get().body);
  delete s.writer; r.db.prepare('UPDATE shadow_state SET body = ? WHERE id = 1').run(JSON.stringify(s));
  const { ShadowController } = await load(); assert.throws(() => new ShadowController(sqlite(r.db)), /Unknown/);
});

test('published checkout remains consumable after launch expiry and releases only with complete terminal graph', async t => {
  const r = await reserved(t); create(r); publish(r);
  const x = { ...r.x, heavyJobId: 1001 };
  r.send('writer-bind-heavy', { generation: 1, execution: x,
    jobs: list([job(x, 1000, 'root'), job(x, 1001, 'heavy')]) });
  const at = T + 60000, f = writerFrame(r.i, at);
  create(r, 'checkout', 501, at, f); publish(r, 'checkout', 501, at, f);
  const now = T + 120001, p = r.c.snapshot(now).reservations[0].checkout;
  r.send('consume', { generation: 1, evidence: list([p], now) }, now);
  const other = job(x, 7777, 'other', null, 'in_progress', 'AI');
  assert.throws(() => r.send('settle', { generation: 1, evidence: terminal(x, now, [other]),
    checkpoint: 'after_checkout', outcome: 'success' }, now), /Unknown/);
  r.send('settle', { generation: 1, evidence: terminal(x, now), checkpoint: 'after_checkout', outcome: 'success' }, now);
  const s = r.c.snapshot(now); assert.equal(s.reservations.length, 0);
  assert.equal(s.history[0].phase, 'Completed'); assert.equal(s.inputs[0].success, true);
  assert.equal(s.writer.writes.length, 4); assert.equal(s.ledger.length, 2);
});


function ownerCheck(i, now) {
  const x = execution(i, 100, 2, 2000);
  return { expected: { input: i, rootInputs: [i] }, observation: {
    attempt: { repoId: i.repoId, runId: 100, number: 2, triggeringActorId: 37964907,
      triggeringActorType: 'User', input: i, observedAt: now }, jobs: list([job(x, 2000, 'root')], now),
    refs: { input: i, observedAt: now }, permission: { actorId: 37964907, value: 'admin', observedAt: now } } };
}

test('owner permission recheck is required at fence and audit retains its scoped provenance', async t => {
  const r = await rig(t), i = input(); queue(r, i);
  const proof = ownerCheck(i, T); r.send('owner', proof);
  const f = writerFrame(i); f.ownerChecks = [proof]; f.terminal = [terminal(execution(i, 100, 2, 2000))];
  r.send('writer-reserve', { frame: f });
  const bad = structuredClone(f); bad.ownerChecks[0].observation.permission.value = 'read';
  assert.throws(() => r.send('writer-fence', { writeId: 1, frame: bad }), /Unknown/);
  r.send('writer-fence', { writeId: 1, frame: f });
  const a = JSON.parse(r.db.prepare("SELECT body FROM shadow_audit WHERE kind = 'writer-fence'").get().body);
  assert.equal(a.writer.ownerChecks[0].permission.actorId, 37964907);
  assert.equal(a.writer.ownerChecks[0].permission.observedAt, T);
  assert.equal(a.writer.ownerChecks[0].jobs.complete, true);
  assert.equal(a.writer.bounds.requestReentriesRemaining, 2);
  assert.equal(new Set(a.targets.map(q => q.generation)).size, a.targets.length);
});

test('audit ignores unconsumed owner observations instead of persisting external text', async t => {
  const r = await reserved(t), f = structuredClone(r.f);
  f.ownerChecks = [{ observation: { permission: { value: 'UNVALIDATED_EXTERNAL_TEXT' } } }];
  prepare(r, 'launch', T, f);
  const a = JSON.parse(r.db.prepare("SELECT body FROM shadow_audit WHERE kind = 'writer-prepare'").get().body);
  assert.deepEqual(a.writer.ownerChecks, []);
  assert.ok(!JSON.stringify(a).includes('UNVALIDATED_EXTERNAL_TEXT'));
});
