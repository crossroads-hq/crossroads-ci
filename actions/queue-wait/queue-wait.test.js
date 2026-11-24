const test = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { analyzeJob, fetchJobs, main, parseThreshold } = require("./queue-wait.js");

const NOW = "2026-11-23T12:00:00Z";
const job = (o) => ({
  name: "Validate", status: "completed", conclusion: "success", runner_id: 1, runner_name: "fast-1",
  created_at: "2026-11-23T10:00:00Z", started_at: "2026-11-23T10:30:00Z", completed_at: "2026-11-23T10:40:00Z", ...o,
});
const ok = (body) => ({ ok: true, status: 200, json: async () => body });
const env = (extra = {}) => ({ GITHUB_REPOSITORY: "o/r", GITHUB_RUN_ID: "1", GITHUB_TOKEN: "t", ...extra });

test("threshold parsing falls back to 20 on bad input", () => {
  assert.deepEqual(parseThreshold("5"), { minutes: 5, valid: true });
  assert.deepEqual(parseThreshold("0"), { minutes: 0, valid: true });
  for (const bad of ["abc", "-1"]) assert.deepEqual(parseThreshold(bad), { minutes: 20, valid: false });
  for (const unset of ["", undefined]) assert.deepEqual(parseThreshold(unset), { minutes: 20, valid: true });
});

test("completed job reports wait and run time", () => {
  const r = analyzeJob(job(), NOW);
  assert.equal(r.wait, 30);
  assert.equal(r.run, 10);
});

test("in-progress job measures run time to now", () => {
  const r = analyzeJob(job({ status: "in_progress", conclusion: null, completed_at: null }), NOW);
  assert.equal(r.run, 90);
});

test("queued, skipped and runner-less cancelled jobs are 'not started', not a 0 wait", () => {
  for (const o of [
    { status: "queued", conclusion: null, started_at: "2026-11-23T10:00:00Z" },
    { conclusion: "skipped", started_at: "2026-11-23T10:00:00Z", runner_id: 0, runner_name: "" },
    { conclusion: "cancelled", runner_id: null, runner_name: null, started_at: "2026-11-23T10:00:00Z" },
  ]) assert.equal(analyzeJob(job(o), NOW).state, "not started");
});

test("missing or invalid timestamps are unknown, never zero", () => {
  assert.equal(analyzeJob(job({ started_at: null }), NOW).wait, null);
  assert.equal(analyzeJob(job({ started_at: "2026-11-23T09:00:00Z" }), NOW).wait, null);
});

test("fetchJobs follows pagination", async () => {
  const pages = [ok({ total_count: 3, jobs: [job(), job()] }), ok({ total_count: 3, jobs: [job()] })];
  let calls = 0;
  const r = await fetchJobs({ fetchImpl: async () => pages[calls++], apiUrl: "https://x", repo: "o/r", runId: "1", token: "t" });
  assert.equal(r.jobs.length, 3);
  assert.equal(calls, 2);
});

test("fetchJobs treats errors, malformed and incomplete responses as unknown", async () => {
  const run = (fetchImpl) => fetchJobs({ fetchImpl, apiUrl: "https://x", repo: "o/r", runId: "1", token: "t" });
  assert.match((await run(async () => ({ ok: false, status: 403 }))).error, /actions: read/);
  assert.match((await run(async () => { throw new Error("boom"); })).error, /boom/);
  assert.match((await run(async () => ok({ jobs: [] }))).error, /malformed/);
  assert.match((await run(async () => ok({ total_count: 5, jobs: [] }))).error, /incomplete/);
  let n = 0;
  assert.match((await run(async () => ok({ total_count: 2, jobs: n++ ? [] : [job()] }))).error, /incomplete \(1 of 2\)/);
});

test("main writes the table and warns only above the threshold", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qw-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const summary = path.join(dir, "s.md");
  const logs = [];
  t.mock.method(console, "log", (m) => logs.push(m));
  const jobs = [job({ name: "Slow|job\nx" }), job({ name: "Fast", started_at: "2026-11-23T10:05:00Z" }), job({ name: "Never", status: "queued", conclusion: null })];
  const r = await main(env({ GITHUB_STEP_SUMMARY: summary, WARN_AFTER_MINUTES: "20" }), async () => ok({ total_count: 3, jobs }), NOW);
  const text = fs.readFileSync(summary, "utf8");
  assert.match(text, /\| Slow\\\|job x \| fast-1 \| completed \| 30\.0 min \| 10\.0 min \|/);
  assert.match(text, /\| Fast \|.*5\.0 min/);
  assert.match(text, /\| Never \|.*not started \| - \|/);
  assert.equal(r.warnings.length, 1);
  assert.match(r.warnings[0], /^::warning title=Long runner queue wait::Slow\|job%0Ax waited 30\.0 min/);
  assert.ok(logs.some((l) => l.startsWith("::warning")));
});

test("main reports unknown instead of a table when the API fails or inputs are missing", async (t) => {
  t.mock.method(console, "log", () => {});
  const failed = await main(env(), async () => ({ ok: false, status: 403 }), NOW);
  assert.match(failed.summary, /Queue wait unknown: HTTP 403/);
  assert.deepEqual(failed.warnings, []);
  const missing = await main({}, undefined, NOW);
  assert.match(missing.summary, /Queue wait unknown/);
});

test("the script exits 0 even when the API is unreachable", () => {
  const result = execFileSync(process.execPath, [path.join(__dirname, "queue-wait.js")], {
    env: { PATH: process.env.PATH, GITHUB_REPOSITORY: "o/r", GITHUB_RUN_ID: "1", GITHUB_TOKEN: "t", GITHUB_API_URL: "http://127.0.0.1:9" },
    encoding: "utf8",
  });
  assert.match(result, /Queue wait unknown/);
});

test("a startup failure or timeout with no runner is 'not started', not a 0 wait", () => {
  for (const conclusion of ["failure", "timed_out", "cancelled", "startup_failure"]) {
    const r = analyzeJob(job({ conclusion, runner_id: 0, runner_name: "", started_at: "2026-11-23T10:00:00Z", completed_at: "2026-11-23T10:00:00Z" }), NOW);
    assert.equal(r.state, "not started", conclusion);
    assert.equal(r.wait, null);
  }
});

test("a hung request becomes unknown within the timeout, even if fetch ignores the signal", async () => {
  const hung = () => new Promise(() => {});
  const r = await fetchJobs({ fetchImpl: hung, apiUrl: "https://x", repo: "o/r", runId: "1", token: "t", timeoutMs: 20 });
  assert.match(r.error, /timed out after 20 ms/);
});

test("an aborted request is reported as unknown", async () => {
  const aborting = (_url, { signal }) => new Promise((_, reject) => signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))));
  const r = await fetchJobs({ fetchImpl: aborting, apiUrl: "https://x", repo: "o/r", runId: "1", token: "t", timeoutMs: 20 });
  assert.match(r.error, /request failed/);
});

test("a hung body read is bounded too", async () => {
  const r = await fetchJobs({ fetchImpl: async () => ({ ok: true, status: 200, json: () => new Promise(() => {}) }), apiUrl: "https://x", repo: "o/r", runId: "1", token: "t", timeoutMs: 20 });
  assert.match(r.error, /timed out/);
});

test("an empty valid job list says no jobs were returned", async (t) => {
  t.mock.method(console, "log", () => {});
  const r = await main(env(), async () => ok({ total_count: 0, jobs: [] }), NOW);
  assert.match(r.summary, /No jobs returned/);
});

test("a 403 prints an unknown note that says to grant actions: read, with no table", async (t) => {
  t.mock.method(console, "log", () => {});
  const r = await main(env(), async () => ({ ok: false, status: 403 }), NOW);
  assert.match(r.summary, /Queue wait unknown: HTTP 403; grant actions: read/);
  assert.doesNotMatch(r.summary, /\| Job \|/);
  assert.deepEqual(r.warnings, []);
});

test("an overall deadline ends a slow multi-page report as unknown", async (t) => {
  t.mock.method(console, "log", () => {});
  const slow = async () => { await new Promise((r) => setTimeout(r, 15)); return ok({ total_count: 1000, jobs: [job()] }); };
  const r = await main(env(), slow, NOW, 40);
  assert.match(r.summary, /overall deadline exceeded/);
});

// The gate action wires the script in for every fleet caller.
const gateAction = JSON.parse(execFileSync("ruby", ["-ryaml", "-rjson", "-e",
  "puts JSON.generate(YAML.safe_load(File.read(ARGV.fetch(0))))", path.join(__dirname, "../gate/action.yml")], { encoding: "utf8" }));
const steps = gateAction.runs.steps;
const waitSteps = steps.filter((s) => /Queue wait summary/.test(s.name));
const checkIndex = steps.findIndex((s) => /Check required results/.test(s.name));

test("the gate action defaults queue wait on, with a 20 minute threshold", () => {
  assert.equal(gateAction.inputs["queue-wait"].default, "true");
  assert.equal(gateAction.inputs["warn-after-minutes"].default, "20");
  assert.deepEqual(Object.keys(gateAction.inputs).slice(0, 2), ["results", "allow-skipped"]);
});

test("queue-wait steps run before the check, never fail the job, and honour the opt-out", () => {
  assert.equal(waitSteps.length, 2);
  for (const step of waitSteps) {
    assert.ok(steps.indexOf(step) < checkIndex);
    assert.equal(step["continue-on-error"], true);
    assert.match(step.if, /!cancelled\(\)/);
    assert.match(step.if, /inputs\.queue-wait != 'false'/);
    assert.deepEqual(Object.keys(step.env).sort(), ["GITHUB_TOKEN", "WARN_AFTER_MINUTES"]);
    assert.match(step.run, /\.\.\/queue-wait\/queue-wait\.js/);
    assert.doesNotMatch(step.run, /\$\{\{ (inputs|github\.token)/);
  }
  assert.ok(fs.existsSync(path.join(__dirname, "queue-wait.js")));
});

test("the check step and its inputs are unchanged", () => {
  const check = steps[checkIndex];
  assert.equal(check.env.RESULTS, "${{ inputs.results }}");
  assert.equal(check.env.ALLOW_SKIPPED, "${{ inputs.allow-skipped }}");
  assert.equal(steps.filter((s) => /Check required results/.test(s.name)).length, 2);
});
