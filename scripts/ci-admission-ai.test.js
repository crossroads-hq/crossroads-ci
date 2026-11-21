const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { spawnSync } = require('node:child_process');
const { join } = require('node:path');
const root = join(__dirname, '..');
const legacyText = readFileSync(join(root, '.github/workflows/_ai-review.yml'), 'utf8');
const admittedText = readFileSync(join(root, '.github/workflows/_ai-review-admission.yml'), 'utf8');
const parse = text => {
  const r = spawnSync('ruby', ['-ryaml', '-rjson', '-e', 'puts JSON.generate(YAML.safe_load(STDIN.read))'], { input: text.replace(/^on:/m, '"on":'), encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
};
const legacy = parse(legacyText), admitted = parse(admittedText);
const pin = '31b0f172dd985ea3fe1c45ee8eb4de35d4f02cc2';
const rootJob = admitted.jobs['admission-ai'], heavy = admitted.jobs.review;
const old = legacy.jobs.review;
const preflight = heavy.steps[0];
const condition = (expression, state = {}) => {
  // Evaluate only the small Actions expression subset used by these conditions.
  // Job success/cancellation is also checked separately: absent a status
  // function, Actions implicitly requires success(). This is a fixture model.
  const vm = require('node:vm');
  const s = { inputs: { 'admission-enabled': true }, needs: { 'admission-ai': { result: 'success' } },
    github: { event_name: 'pull_request', actor: 'owner', repository: 'org/repo',
      event: { pull_request: { draft: false, title: 'Change', head: { repo: { full_name: 'org/repo' } } } } },
    steps: { changes: { outputs: {} }, dedup: { outputs: {} }, codex: { outputs: {} }, review: {}, posted: {} },
    contains: (value, needle) => value.includes(needle), failure: () => false, cancelled: () => false,
    ...state };
  const js = expression.trim().replace(/^\$\{\{([\s\S]*)\}\}$/, '$1')
    .replace(/\.([a-zA-Z][a-zA-Z0-9]*-[a-zA-Z0-9-]+)/g, (_, key) => `["${key}"]`);
  return Boolean(vm.runInNewContext(js, s, { timeout: 100 }));
};
const step = name => heavy.steps.find(s => s.name === name);

test('generated admission workflow is current and the original workflow remains its owner', () => {
  const r = spawnSync(process.execPath, ['scripts/generate-ai-admission.js', '--check'], { cwd: root, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(heavy.name, old.name);
  const actual = structuredClone(heavy), expected = structuredClone(old);
  actual.steps.shift(); delete actual.needs;
  actual.if = expected.if;
  actual['runs-on'] = expected['runs-on'];
  delete actual.permissions.checks;
  assert.deepEqual(actual, expected, 'every remaining reviewer field and step must match');
});

test('default is OFF and no existing workflow opts in or changes its gate', () => {
  const inputs = admitted.on.workflow_call.inputs;
  assert.deepEqual(inputs['admission-enabled'], { description: 'Select the dormant AI admission path. This does not enroll a repository or activate the pilot.', type: 'boolean', required: false, default: false });
  assert.equal(condition(rootJob.if, { inputs: { 'admission-enabled': false } }), false);
  assert.equal(condition(heavy.if, { inputs: { 'admission-enabled': false } }), false);
  const ci = parse(readFileSync(join(root, '.github/workflows/ci.yml'), 'utf8'));
  assert.deepEqual(ci.jobs.gate.needs, ['changes', 'workflow-lint', 'scripts', 'supply-chain']);
  assert.equal(ci.jobs.gate.name, 'PR Validation');
  assert.equal(ci.jobs.gate.if, '${{ !cancelled() }}');
  assert.ok(!Object.values(ci.jobs).some(j => /_ai-review/.test(j.uses || '')));
  assert.match(readFileSync(join(root, 'actions/admission/verify.mjs'), 'utf8'), /ENROLLMENTS = Object.freeze\(\[\]\)/);
});

test('new endpoint preserves all legacy inputs except closed runner selection, and identical secrets', () => {
  const actual = structuredClone(admitted.on.workflow_call.inputs);
  delete actual['admission-enabled'];
  const expected = structuredClone(legacy.on.workflow_call.inputs);
  delete expected['runner-labels'];
  assert.deepEqual(actual, expected);
  assert.deepEqual(admitted.on.workflow_call.secrets, legacy.on.workflow_call.secrets);
  assert.deepEqual(admitted.permissions, legacy.permissions);
  assert.deepEqual(rootJob['runs-on'], ['self-hosted', 'Linux', 'X64', 'light']);
  assert.deepEqual(heavy['runs-on'], ['self-hosted', 'Linux', 'X64', 'fast']);
  assert.equal(rootJob['timeout-minutes'], 2);
});

test('light root has exact read grants and one proven immutable action without checkout or outputs', () => {
  assert.deepEqual(rootJob.permissions, { contents: 'read', actions: 'read', checks: 'read', 'pull-requests': 'read' });
  assert.equal(rootJob.steps.length, 1);
  assert.equal(rootJob.steps[0].uses, `crossroads-hq/crossroads-ci/actions/admission-root@${pin}`);
  assert.equal(rootJob.steps[0].with, undefined);
  assert.equal(rootJob.outputs, undefined);
  assert.equal(rootJob.needs, undefined);
  assert.equal(rootJob.env, undefined);
  assert.equal(rootJob.steps[0]['continue-on-error'], undefined);
});

test('actual heavy job verifies first on every attempt before any legacy step or checkout', () => {
  assert.equal(heavy.needs, 'admission-ai');
  assert.match(heavy.if, /needs\.admission-ai\.result == 'success'/);
  assert.equal(preflight.uses, `crossroads-hq/crossroads-ci/actions/admission-checkout@${pin}`);
  assert.equal(preflight.if, undefined);
  assert.equal(preflight.with, undefined);
  assert.equal(preflight['continue-on-error'], undefined);
  assert.equal(heavy['continue-on-error'], undefined);
  assert.equal(heavy.outputs, undefined);
  assert.equal(heavy.env, undefined);
  assert.deepEqual(heavy.permissions, { ...old.permissions, checks: 'read' });
  assert.ok(heavy.steps.findIndex(s => s.name === 'Checkout') > 0);
  assert.ok(!JSON.stringify(preflight).includes('needs.'));
});

test('root and heavy preserve event, actor, draft, skip-title and same-repository guards', () => {
  for (const job of [rootJob, heavy]) {
    assert.equal(condition(job.if), true);
    for (const field of ['push', 'merge_group', 'workflow_dispatch', 'pull_request_target']) {
      const github = structuredClone({ event_name: field, actor: 'owner', repository: 'org/repo', event: { pull_request: { draft: false, title: 'Change', head: { repo: { full_name: 'org/repo' } } } } });
      assert.equal(condition(job.if, { github }), false, field);
    }
    for (const mutate of [g => { g.actor = 'dependabot[bot]'; }, g => { g.event.pull_request.draft = true; },
      g => { g.event.pull_request.title = '[skip-ai-review] Change'; }, g => { g.event.pull_request.head.repo.full_name = 'fork/repo'; }]) {
      const github = { event_name: 'pull_request', actor: 'owner', repository: 'org/repo', event: { pull_request: { draft: false, title: 'Change', head: { repo: { full_name: 'org/repo' } } } } };
      mutate(github); assert.equal(condition(job.if, { github }), false);
    }
  }
});

test('root Held/Unknown/failure/cancel/skipped never starts heavy or silently falls back', () => {
  for (const result of ['failure', 'cancelled', 'skipped', '', 'unknown']) {
    assert.equal(condition(heavy.if, { needs: { 'admission-ai': { result } } }), false, result);
  }
  assert.doesNotMatch(heavy.if, /always\(|!cancelled\(|failure\(/);
  assert.doesNotMatch(rootJob.if, /always\(|!cancelled\(|failure\(/);
});

test('first preflight failure cannot run the reviewer or produce an inherited success report', () => {
  // Ordinary steps implicitly require success(). Status-aware reporters are
  // the exception, so evaluate their actual guards with no preceding outputs.
  for (const s of heavy.steps.slice(1)) {
    if (s.if && /failure\(|cancelled\(|always\(/.test(s.if)) {
      assert.equal(condition(s.if, { failure: () => true }), false, s.name);
    }
  }
  for (const name of ['Wait for Codex review', 'Checkout', 'Claude review']) {
    assert.doesNotMatch(step(name).if, /failure\(|cancelled\(|always\(/);
  }
});

test('Codex verified evidence, unknown evidence, dedup and fallback retain their original routing', () => {
  const steps = { changes: { outputs: { reviewable: 'true' } }, dedup: { outputs: { skip: 'false' } },
    codex: { outputs: { reviewed: 'true' } } };
  assert.equal(condition(step('Wait for Codex review').if, { steps }), true);
  assert.equal(condition(step('Claude review').if, { steps }), false);
  for (const reviewed of ['', undefined, 'false', 'unknown']) {
    steps.codex.outputs.reviewed = reviewed;
    assert.equal(condition(step('Claude review').if, { steps }), true);
    assert.equal(condition(step('Checkout').if, { steps }), true);
  }
  steps.dedup.outputs.skip = 'true';
  assert.equal(condition(step('Claude review').if, { steps }), false);
  assert.equal(condition(step('Wait for Codex review').if, { steps }), false);
});

test('drift check detects a changed generated workflow and a changed owner workflow', () => {
  const { render } = require('./generate-ai-admission.js');
  assert.equal(render(legacyText), admittedText);
  assert.notEqual(render(legacyText.replace('default: 300', 'default: 299')), admittedText);
  assert.notEqual(render(legacyText), admittedText.replace(pin, '0'.repeat(40)));
  assert.throws(() => render(legacyText.replace('    steps:', '    removed-steps:')), /owner workflow/);
});
