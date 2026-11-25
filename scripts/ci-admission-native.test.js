const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { readFileSync } = require('node:fs');
const T = Date.parse('2026-11-21T10:00:00Z');
const load = () => import('./lib/ci-admission-native.mjs');
function fixture(phase = 'launch', attempt = 1) {
  const repoId = 1305651079, head = 'a'.repeat(40), baseSha = 'b'.repeat(40), mergeSha = 'c'.repeat(40);
  const enrollment = { repoId, repository: 'crossroads-hq/crossroads-ui', workflowId: 50,
    workflow: '.github/workflows/ci.yml', digest: 'd'.repeat(64), schedulerAppId: 900,
    root: { key: 'admission-verify', name: 'Admission Verify' }, heavy: { key: 'verify', name: 'Verify' },
    workload: 'Verify', capability: 'fast', files: [{ path: '.github/workflows/ci.yml', sha256: 'e'.repeat(64) }] };
  const context = { repoId, runId: 100, attempt, jobKey: phase === 'launch' ? enrollment.root.key : enrollment.heavy.key,
    runnerName: 'fixture-runner', sha: mergeSha, workflowSha: mergeSha,
    workflowRef: `${enrollment.repository}/${enrollment.workflow}@refs/pull/42/merge`, eventName: 'pull_request' };
  const pr = { number: 42, state: 'open', draft: false, head: { sha: head, repo: { id: repoId } },
    base: { ref: 'main', sha: baseSha, repo: { id: repoId } }, merge_commit_sha: mergeSha };
  const run = { id: 100, run_attempt: attempt, event: 'pull_request', status: 'in_progress', conclusion: null,
    workflow_id: 50, path: enrollment.workflow, head_sha: head, repository: { id: repoId }, head_repository: { id: repoId },
    pull_requests: [{ number: 42, head: { sha: head, repo: { id: repoId } }, base: { ref: 'main', sha: baseSha, repo: { id: repoId } } }] };
  const input = { repoId, pr: 42, head, baseRef: 'main', baseSha, mergeSha, workflow: enrollment.workflow,
    digest: enrollment.digest, workload: 'Verify', capability: 'fast' };
  const execution = { repoId, runId: 100, attempt, rootJobId: attempt * 1000, heavyJobId: phase === 'checkout' ? attempt * 1000 + 1 : null, generation: 1 };
  const permit = { id: 500, appId: 900, input, execution, phase, status: 'completed', conclusion: 'success',
    launchIssuedAt: T, issuedAt: T, expiresAt: T + 120000 };
  const check = { id: 500, app: { id: 900 }, name: `CI admission ${phase} / Verify`, head_sha: mergeSha,
    status: 'completed', conclusion: 'success', external_id: 'hq-085/v1/1/' + phase,
    output: { text: JSON.stringify({ protocol: 'hq-085-permit-v1', ...permit }) } };
  const jobId = phase === 'launch' ? execution.rootJobId : execution.heavyJobId;
  const job = { id: jobId, run_id: 100, run_attempt: attempt, head_sha: head,
    name: phase === 'launch' ? 'Admission Verify' : 'Verify', status: 'in_progress', conclusion: null,
    runner_id: 19, runner_name: 'fixture-runner', check_run_url: `https://api.github.com/repos/${enrollment.repository}/check-runs/700` };
  const root = { ...job, id: execution.rootJobId, name: 'Admission Verify', status: 'completed', conclusion: 'success', runner_name: 'other-runner' };
  const list = items => ({ items, complete: true, observedAt: T });
  const sample = { readStartedAt: T, readCompletedAt: T, repository: { id: repoId, full_name: enrollment.repository },
    event: { repository: { id: repoId }, pull_request: structuredClone(pr) }, run, attempt: structuredClone(run), pr,
    base: { ref: 'refs/heads/main', object: { sha: baseSha } }, merge: { ref: 'refs/pull/42/merge', object: { sha: mergeSha } },
    workflowDigest: enrollment.digest, jobs: list(phase === 'launch' ? [job] : [root, job]), checks: list([check]), actualJob: job,
    jobCheck: { id: 700, app: { id: 15368 }, head_sha: head, status: 'in_progress', conclusion: null,
      details_url: `https://github.com/${enrollment.repository}/actions/runs/100/job/${jobId}` } };
  return { sample, enrollment, context, phase, permit };
}

test('initial root verifies launch without waiting for any heavy job identity', async () => {
  const { nativeDecision } = await load(), f = fixture();
  assert.equal(nativeDecision(f.sample, f.enrollment, f.context, f.phase, T).status, 'Verified');
});
test('every checkout uses its actual attempt/job even with cached root outputs', async () => {
  const { nativeDecision } = await load(), f = fixture('checkout', 2);
  assert.equal(nativeDecision(f.sample, f.enrollment, f.context, f.phase, T).status, 'Verified');
  f.context.attempt = 3;
  assert.equal(nativeDecision(f.sample, f.enrollment, f.context, f.phase, T).status, 'Held');
});
test('actual job re-fetch compares native identity independently of JSON property order', async () => {
  const { nativeDecision } = await load(), f = fixture('checkout');
  f.sample.actualJob = Object.fromEntries(Object.entries(f.sample.actualJob).reverse());
  assert.equal(nativeDecision(f.sample, f.enrollment, f.context, f.phase, T).status, 'Verified');
});
test('reviewed local closure supports .github paths while refusing traversal', async () => {
  const { validEnrollment } = await load(), f = fixture();
  f.enrollment.files.push({ path: '.github/actions/helper/action.yml', sha256: 'e'.repeat(64) });
  assert.equal(validEnrollment(f.enrollment), true);
  for (const path of ['../helper', '.github/../helper', '.github//helper', '/absolute', 'helper/.hidden', 'helper/file.lock']) {
    f.enrollment.files[1].path = path; assert.equal(validEnrollment(f.enrollment), false);
  }
});
test('native provenance, refs, completeness and job faults always hold', async t => {
  const { nativeDecision } = await load();
  const faults = {
    wrongApp: f => { f.sample.checks.items[0].app.id = 901; },
    wrongCheck: f => { f.sample.checks.items[0].id = 501; },
    wrongNativeApp: f => { f.sample.jobCheck.app.id = 900; },
    duplicateGeneration: f => { f.sample.checks.items.push(structuredClone(f.sample.checks.items[0])); },
    secondGeneration: f => { const c = structuredClone(f.sample.checks.items[0]); c.id = 501; const p = JSON.parse(c.output.text); p.id = 501; p.execution.generation = 2; c.output.text = JSON.stringify(p); c.external_id = 'hq-085/v1/2/checkout'; f.sample.checks.items.push(c); },
    unknownStatus: f => { f.sample.checks.items[0].status = 'invented'; },
    wrongJob: f => { const c = f.sample.checks.items[0], p = JSON.parse(c.output.text); p.execution.heavyJobId = 999; c.output.text = JSON.stringify(p); },
    wrongRoot: f => { const c = f.sample.checks.items[0], p = JSON.parse(c.output.text); p.execution.rootJobId = 999; c.output.text = JSON.stringify(p); },
    conflictingLaunchClock: f => { const c = fixture().sample.checks.items[0], p = JSON.parse(c.output.text);
      c.id = p.id = 499; p.launchIssuedAt--; p.issuedAt--; p.expiresAt--; c.output.text = JSON.stringify(p); f.sample.checks.items.push(c); },
    conflictingLaunchRoot: f => { const c = fixture().sample.checks.items[0], p = JSON.parse(c.output.text);
      c.id = p.id = 499; p.execution.rootJobId = 999; c.output.text = JSON.stringify(p); f.sample.checks.items.push(c); },
    foreignRepo: f => { f.sample.repository.id = 1318535693; },
    wrongWorkflow: f => { f.sample.run.workflow_id++; },
    changedHead: f => { f.sample.pr.head.sha = 'f'.repeat(40); },
    changedBase: f => { f.sample.base.object.sha = 'f'.repeat(40); },
    changedMerge: f => { f.sample.merge.object.sha = 'f'.repeat(40); },
    changedDigest: f => { f.sample.workflowDigest = 'f'.repeat(64); },
    partialJobs: f => { f.sample.jobs.complete = false; },
    missingChecks: f => { delete f.sample.checks; },
    nonList: f => { f.sample.checks.items = {}; },
    stale: f => { f.sample.readStartedAt = T - 60001; },
    future: f => { f.sample.readCompletedAt = T + 1; },
    forgedJobUrl: f => { f.sample.actualJob.check_run_url = 'https://attacker.invalid/token'; },
    ambiguousJob: f => { f.sample.jobs.items.push({ ...f.sample.actualJob, id: 999 }); },
    missingActual: f => { f.sample.jobs.items = f.sample.jobs.items.filter(j => j.id !== f.sample.actualJob.id); },
    heavyOnly: f => { f.sample.jobs.items = [f.sample.actualJob]; },
    fork: f => { f.sample.event.pull_request.head.repo.id = 999; },
    draft: f => { f.sample.pr.draft = true; },
  };
  for (const [name, fault] of Object.entries(faults)) await t.test(name, () => {
    const f = fixture('checkout'); fault(f);
    assert.equal(nativeDecision(f.sample, f.enrollment, f.context, f.phase, T).status, 'Held');
  });
});
test('phase timing fences expired launch and late checkout publication without late renewal', async () => {
  const { nativeDecision } = await load();
  const root = fixture();
  assert.equal(nativeDecision(root.sample, root.enrollment, root.context, root.phase, T + 120000).status, 'Held');
  const f = fixture('checkout'), c = f.sample.checks.items[0], p = JSON.parse(c.output.text);
  p.issuedAt = T + 120000; p.expiresAt = p.issuedAt + 120000; c.output.text = JSON.stringify(p);
  f.sample.readStartedAt = f.sample.readCompletedAt = f.sample.jobs.observedAt = f.sample.checks.observedAt = T + 120000;
  assert.equal(nativeDecision(f.sample, f.enrollment, f.context, f.phase, T + 120000).status, 'Held');
});
test('short polling uses an absolute 30-second deadline and never returns expired success', async () => {
  const { pollAdmission } = await load(), f = fixture(); let now = T, reads = 0;
  const result = await pollAdmission({ ...f, now: () => now, sleep: async ms => { now += ms; }, read: async () => {
    reads++; const s = structuredClone(f.sample); s.readStartedAt = s.readCompletedAt = s.jobs.observedAt = s.checks.observedAt = now;
    s.checks.items = []; return s;
  } });
  assert.equal(result.status, 'Held'); assert.equal(now, T + 30000); assert.equal(reads, 6);
  now = T; const slow = await pollAdmission({ ...f, now: () => now, sleep: async ms => { now += ms; },
    read: async () => { now += 31000; return f.sample; } });
  assert.equal(slow.status, 'Held');
});
test('shipped actions have no enrollment or runtime enable switch and fail with fixed text', () => {
  for (const phase of ['launch', 'checkout']) {
    const result = spawnSync(process.execPath, ['actions/admission/verify.mjs', phase], {
      cwd: __dirname + '/..', encoding: 'utf8', env: { PATH: process.env.PATH, ADMISSION_ENABLED: 'true' } });
    assert.equal(result.status, 1); assert.equal(result.stderr.trim(), 'Admission held'); assert.equal(result.stdout, '');
  }
  for (const action of ['admission-root', 'admission-checkout']) {
    const source = readFileSync(`${__dirname}/../actions/${action}/action.yml`, 'utf8');
    assert.doesNotMatch(source, /uses:|checkout@|npm |outputs:|github-token|\$\{\{[^\n]*\}\}[^\n]*node/);
    assert.match(source, /GH_TOKEN: \$\{\{ github.token \}\}/);
  }
});

test('complete native pages require exact stable totals, unique IDs and bounded coverage', async () => {
  const { collectPages } = await import('../actions/admission/read.mjs');
  const items = Array.from({ length: 101 }, (_, n) => ({ id: n + 1 }));
  const get = async path => ({ body: { total_count: 101, jobs: path.includes('page=2') ? items.slice(100) : items.slice(0, 100) }, next: !path.includes('page=2') });
  assert.deepEqual(await collectPages(get, '/fixed', 'jobs'), items);
  for (const body of [{ total_count: 0 }, { total_count: 1, jobs: {} }, { total_count: 2, jobs: [{ id: 1 }] },
    { total_count: 2, jobs: [{ id: 1 }, { id: 1 }] }, { total_count: 1001, jobs: [] },
    { total_count: 0, jobs: [{ id: 1 }] }]) {
    await assert.rejects(collectPages(async () => ({ body, next: false }), '/fixed', 'jobs'), /Admission held/);
  }
  await assert.rejects(collectPages(async path => ({ body: { total_count: path.includes('page=2') ? 102 : 101,
    jobs: path.includes('page=2') ? items.slice(100) : items.slice(0, 100) }, next: !path.includes('page=2') }), '/fixed', 'jobs'));
  await assert.rejects(collectPages(async () => ({ body: { total_count: 0, jobs: [] }, next: true }), '/fixed', 'jobs'));
});
test('HTTP transport is fixed-origin GET only, refuses redirects/errors and bounds reads', async () => {
  const { githubReader } = await import('../actions/admission/read.mjs'); let calls = 0;
  const fetchImpl = async (url, opts) => {
    calls++; assert.equal(url, 'https://api.github.com/repositories/1305651079');
    assert.equal(opts.method, 'GET'); assert.equal(opts.redirect, 'error');
    assert.equal(opts.headers.authorization, 'Bearer fixture-read-token');
    return new Response('{"id":1305651079}', { status: 200 });
  };
  const get = githubReader({ token: 'fixture-read-token', deadline: T + 30000, now: () => T, fetchImpl });
  assert.equal((await get('/repositories/1305651079')).body.id, 1305651079);
  for (const path of ['https://attacker.invalid/', '//attacker.invalid', '/repos/x/../secret', '/repositories/1\n']) await assert.rejects(get(path));
  assert.equal(calls, 1);
  for (const status of [302, 403, 429, 500]) {
    const bad = githubReader({ token: 'fixture', deadline: T + 30000, now: () => T,
      fetchImpl: async () => new Response('arbitrary upstream token body', { status }) });
    await assert.rejects(bad('/repositories/1305651079'), /^Error: Admission held$/);
  }
});

test('native reader composes exact API data and rechecks mutable anchors without checkout', async () => {
  const { readNative, closureDigest } = await import('../actions/admission/read.mjs');
  const { createHash } = require('node:crypto');
  const { nativeDecision } = await load(), f = fixture('checkout');
  const content = 'synthetic reviewed workflow bytes';
  f.enrollment.files[0].sha256 = createHash('sha256').update(content).digest('hex');
  f.enrollment.digest = closureDigest(f.enrollment.files); f.sample.workflowDigest = f.enrollment.digest;
  const p = JSON.parse(f.sample.checks.items[0].output.text); p.input.digest = f.enrollment.digest;
  f.sample.checks.items[0].output.text = JSON.stringify(p);
  const base = '/repos/' + f.enrollment.repository; const visited = [];
  let mutate = false;
  const fetchImpl = async (url, opts) => {
    assert.equal(opts.method, 'GET'); const path = url.slice('https://api.github.com'.length); visited.push(path);
    let value;
    if (path.startsWith('/repositories/')) value = f.sample.repository;
    else if (path === base + '/actions/runs/100') value = f.sample.run;
    else if (path === base + '/actions/runs/100/attempts/1') value = f.sample.attempt;
    else if (path === base + '/pulls/42') value = mutate && visited.filter(x => x === path).length > 1 ? { ...f.sample.pr, draft: true } : f.sample.pr;
    else if (path === base + '/git/ref/heads/main') value = f.sample.base;
    else if (path === base + '/git/ref/pull/42/merge') value = f.sample.merge;
    else if (path.startsWith(base + '/contents/')) value = { type: 'file', path: f.enrollment.workflow,
      encoding: 'base64', content: Buffer.from(content).toString('base64') };
    else if (path.startsWith(base + '/actions/runs/100/attempts/1/jobs?')) value = { total_count: f.sample.jobs.items.length, jobs: f.sample.jobs.items };
    else if (path === base + '/actions/jobs/1001') value = f.sample.actualJob;
    else if (path === base + '/check-runs/700') value = f.sample.jobCheck;
    else if (path.startsWith(base + '/commits/')) { assert.match(path, /filter=all&per_page=100&page=1$/); value = { total_count: 1, check_runs: f.sample.checks.items }; }
    else throw new Error('Unexpected fixture path ' + path);
    return new Response(JSON.stringify(value), { status: 200 });
  };
  const options = { enrollment: f.enrollment, context: f.context, event: f.sample.event,
    token: 'synthetic', deadline: T + 30000, now: () => T, fetchImpl };
  let s = await readNative(options); assert.ok(s);
  assert.equal(nativeDecision(s, f.enrollment, f.context, 'checkout', T).status, 'Verified');
  assert.equal(visited.filter(x => x.startsWith('/repositories/')).length, 2);
  visited.length = 0; mutate = true; assert.equal(await readNative(options), null);
});
