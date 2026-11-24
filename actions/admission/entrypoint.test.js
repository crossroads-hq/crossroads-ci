const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join, resolve, dirname, delimiter } = require('node:path');

const TOKEN = 'synthetic-admission-test-token';
const actions = [['admission-root', 'launch'], ['admission-checkout', 'checkout']];
function declaration(name) {
  const path = resolve(__dirname, '..', name, 'action.yml');
  const result = spawnSync('ruby', ['-ryaml', '-rjson', '-e',
    'puts JSON.generate(YAML.safe_load(File.read(ARGV[0])))', path], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout).runs.steps[0];
}
function scratch(t) {
  const dir = mkdtempSync(join(tmpdir(), 'admission-entry-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
// Evaluate only the exact guard grammar supported by these declarations, using
// Runner Index/ToJson null semantics. No general expression evaluator or eval.
function shellFor(step, env, os) {
  if (!step.shell.startsWith('${{')) return step.shell;
  const expression = step.shell.slice(3, -2).trim().replace(/\s+/g, ' ');
  const choices = expression.match(/^(.*)&& '\/usr\/bin\/node -- "\{0\}"' \|\| '\/usr\/bin\/node Admission-held'$/s);
  assert.ok(choices, 'Unexpected shell guard grammar');
  const conditions = choices[1].split('&&').map(s => s.trim());
  assert.equal(conditions.shift(), "runner.os == 'Linux'");
  const safe = os === 'Linux' && conditions.every(condition => {
    const match = condition.match(/^toJSON\(env\.([A-Z0-9_]+)\) == 'null'$/);
    assert.ok(match, condition);
    return !Object.hasOwn(env, match[1]);
  });
  return safe ? '/usr/bin/node -- "{0}"' : '/usr/bin/node Admission-held';
}
// Execute literal declarations with Runner's resolution/format ordering. A
// fixed existing absolute executable bypasses managed prepend and PATH search.
// macOS maps the Linux-only fixed Node to this test process's Node; Linux uses
// /usr/bin/node itself. Neither is a native GitHub action-execution proof.
function execute(step, dir, actionPath, caller = {}, { prependPath = [], os = 'Linux' } = {}) {
  const env = { PATH: process.env.PATH, GITHUB_ACTION_PATH: actionPath, ...caller };
  for (const [key, value] of Object.entries(step.env || {})) {
    assert.equal(typeof value, 'string');
    env[key] = value === '${{ github.token }}' ? TOKEN : value;
  }
  const shell = shellFor(step, env, os), [command] = shell.split(' ');
  const format = shell.slice(command.length).trim();
  if (format && !format.includes('{0}')) return { status: 1, stdout: '', stderr: 'Invalid shell option: Admission-held', started: false };
  let executable;
  if (command === '/usr/bin/node') executable = process.platform === 'linux' ? command : process.execPath;
  else if (command === 'bash') executable = '/bin/bash';
  else if (command === 'node') executable = [...prependPath, dirname(process.execPath), ...process.env.PATH.split(delimiter)]
    .map(path => join(path, 'node')).find(existsSync);
  assert.ok(executable, `Unexpected interpreter: ${command}`);
  if (prependPath.length) env.PATH = [...prependPath, env.PATH].join(delimiter);
  const file = join(dir, 'step with spaces'); writeFileSync(file, step.run);
  const parameters = format === '-- "{0}"' ? ['--', file] :
    ['--noprofile', '--norc', '-e', '-o', 'pipefail', file];
  return { ...spawnSync(executable, parameters, { encoding: 'utf8', cwd: dir, env }), started: true };
}
function held(result) {
  assert.equal(result.status, 1, result.stderr);
  assert.equal(result.stdout, '', 'Caller startup code ran before admission refusal');
  assert.equal(result.stderr.trim(), 'Admission held');
  assert.equal((result.stdout + result.stderr).includes(TOKEN), false);
}

for (const [name, phase] of actions) {
  test(`${name} refuses Node preload hooks before token access`, t => {
    const dir = scratch(t), step = declaration(name);
    const hook = `process.stdout.write('hook:' + process.env.GH_TOKEN + '\\n')`;
    held(execute(step, dir, resolve(__dirname, '..', name), {
      NODE_OPTIONS: '--import=data:text/javascript,' + encodeURIComponent(hook), NODE_PATH: dir,
    }));
  });
  test(`${name} refuses shell startup files and exported functions`, t => {
    const dir = scratch(t), step = declaration(name), hook = join(dir, 'shell-hook');
    writeFileSync(hook, 'printf "shell-hook:%s\\n" "$GH_TOKEN"\n');
    held(execute(step, dir, resolve(__dirname, '..', name), { BASH_ENV: hook, ENV: hook,
      'BASH_FUNC_node%%': '() { printf "function-hook:%s\\n" "$GH_TOKEN"; }' }));
  });
  test(`${name} bypasses caller step PATH interpreter replacements`, t => {
    const dir = scratch(t), step = declaration(name), bin = join(dir, 'bin'); mkdirSync(bin);
    for (const file of ['node', 'bash']) writeFileSync(join(bin, file),
      '#!/bin/sh\nprintf "path-hook:%s\\n" "$GH_TOKEN"\n', { mode: 0o755 });
    held(execute(step, dir, resolve(__dirname, '..', name), { PATH: `${bin}:${process.env.PATH}` }));
  });
  test(`${name} bypasses poisoned runner GITHUB_PATH prepend entries`, t => {
    const dir = scratch(t), step = declaration(name), bin = join(dir, 'attacker prepend'); mkdirSync(bin);
    writeFileSync(join(bin, 'node'), '#!/bin/sh\nprintf "prepend-hook:%s\\n" "$GH_TOKEN"\n', { mode: 0o755 });
    held(execute(step, dir, resolve(__dirname, '..', name), {}, { prependPath: [bin] }));
    assert.match(step.shell, /'\/usr\/bin\/node -- "\{0\}"'/);
    assert.equal(step.if, undefined, 'Unsafe startup must fail, never skip verification');
  });
  test(`${name} prepend fixture exposes a bare-interpreter regression`, t => {
    const dir = scratch(t), step = declaration(name), bin = join(dir, 'attacker prepend'); mkdirSync(bin);
    writeFileSync(join(bin, 'node'), '#!/bin/sh\nprintf "prepend-hook:%s\\n" "$GH_TOKEN"\n', { mode: 0o755 });
    const result = execute({ ...step, shell: 'node -- "{0}"' }, dir,
      resolve(__dirname, '..', name), {}, { prependPath: [bin] });
    assert.equal(result.started, true);
    assert.equal(result.stdout.trim(), 'prepend-hook:' + TOKEN);
  });
  test(`${name} rejects loader hooks by presence before any process starts`, t => {
    const dir = scratch(t), step = declaration(name);
    const keys = ['LD_PRELOAD', 'LD_AUDIT', 'LD_LIBRARY_PATH', 'LD_DEBUG', 'LD_DEBUG_OUTPUT',
      'LD_TRACE_LOADED_OBJECTS', 'LD_TRACE_PRELINKING', 'LD_PROFILE', 'LD_PROFILE_OUTPUT', 'LD_ORIGIN_PATH', 'GLIBC_TUNABLES',
      'DYLD_INSERT_LIBRARIES', 'DYLD_LIBRARY_PATH', 'DYLD_FRAMEWORK_PATH', 'DYLD_FALLBACK_LIBRARY_PATH',
      'DYLD_FALLBACK_FRAMEWORK_PATH', 'DYLD_VERSIONED_LIBRARY_PATH', 'DYLD_VERSIONED_FRAMEWORK_PATH',
      'DYLD_ROOT_PATH', 'DYLD_IMAGE_SUFFIX', 'DYLD_PRINT_ENV', 'DYLD_PRINT_TO_FILE',
      'DYLD_JUST_BUILD_CLOSURE', 'DYLD_SKIP_MAIN', 'OPENSSL_CONF', 'OPENSSL_CONF_INCLUDE',
      'OPENSSL_ENGINES', 'OPENSSL_MODULES'];
    for (const key of keys) for (const value of ['', '0', '1', '/untrusted/loader']) {
      assert.equal(Object.hasOwn(step.env, key), false, `Do not blank presence-sensitive loader key ${key}`);
      const result = execute(step, dir, resolve(__dirname, '..', name), { [key]: value });
      assert.equal(result.started, false, key);
      assert.equal(result.status, 1, key); assert.equal(result.stdout, ''); assert.equal(result.stderr.includes(TOKEN), false);
    }
    assert.equal(execute(step, dir, resolve(__dirname, '..', name), {}, { os: 'Windows' }).started, false);
    assert.equal(execute(step, dir, resolve(__dirname, '..', name), {}, { os: 'macOS' }).started, false);
  });
  test(`${name} preserves the clean disabled refusal`, t => {
    const dir = scratch(t), step = declaration(name);
    held(execute(step, dir, resolve(__dirname, '..', name)));
  });
  test(`${name} fixes phase and handles verified, held and error results`, t => {
    const dir = scratch(t), step = declaration(name), root = join(dir, 'actions');
    mkdirSync(join(root, name), { recursive: true }); mkdirSync(join(root, 'admission'));
    const module = join(root, 'admission', 'verify.mjs');
    const prefix = `export async function runAction(phase) { if (phase !== ${JSON.stringify(phase)} || process.env.GH_TOKEN !== ${JSON.stringify(TOKEN)}) throw new Error('fixture mismatch'); `;
    for (const [body, status] of [["return { status: 'Verified' }; }", 0],
      ["return { status: 'Held' }; }", 1], ["throw new Error(process.env.GH_TOKEN); }", 1]]) {
      // Each invocation is a new child process with no enrollment or network,
      // so modifying this test-only module never reuses an earlier module cache.
      writeFileSync(module, prefix + body);
      const result = execute(step, dir, join(root, name));
      if (status) held(result);
      else { assert.equal(result.status, 0, result.stderr); assert.equal(result.stdout, ''); assert.equal(result.stderr, ''); }
    }
  });
}
