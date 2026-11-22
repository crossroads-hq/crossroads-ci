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
