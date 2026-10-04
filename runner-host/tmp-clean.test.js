// Tests for fleet-tmp-clean.sh. The real script runs against a scratch
// directory standing in for /tmp, with file times set into the past. Run with:
//
//   node --test runner-host/tmp-clean.test.js
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const SCRIPT = path.join(__dirname, "fleet-tmp-clean.sh");
const HOUR = 3600;
const now = () => Math.floor(Date.now() / 1000);

function scratch() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tmp-clean-"));
  // Write a file at `rel` whose times are `ageHours` in the past, and age its
  // parent folders the same unless they were aged already.
  const file = (rel, ageHours) => {
    const f = path.join(tmp, rel);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, "x".repeat(2048));
    const t = now() - ageHours * HOUR;
    fs.utimesSync(f, t, t);
  };
  const age = (rel, ageHours) => {
    const t = now() - ageHours * HOUR;
    fs.utimesSync(path.join(tmp, rel), t, t);
  };
  const run = (env = {}) => {
    const r = spawnSync("bash", [SCRIPT], { encoding: "utf8", env: { PATH: process.env.PATH, TMP_DIR: tmp, ...env } });
    return { code: r.status, out: r.stdout + r.stderr };
  };
  const exists = (rel) => fs.existsSync(path.join(tmp, rel));
  return { tmp, file, age, run, exists };
}

test("removes a stale crossroads-* folder, keeps fresh ones and other names", () => {
  const s = scratch();
  s.file("crossroads-dt1-react18-old/npm-cache/blob", 48);
  s.age("crossroads-dt1-react18-old/npm-cache", 48);
  s.age("crossroads-dt1-react18-old", 48);
  s.file("crossroads-export-install-new/package.json", 1);
  s.file("other-tool-old/data", 48);
  s.age("other-tool-old", 48);
  const r = s.run();
  assert.strictEqual(r.code, 0, r.out);
  assert.ok(!s.exists("crossroads-dt1-react18-old"), r.out);
  assert.ok(s.exists("crossroads-export-install-new"));
  assert.ok(s.exists("other-tool-old"), "only the configured patterns are touched");
  assert.match(r.out, /removed 1, kept 0/);
});

test("keeps an old folder that a job is still writing inside", () => {
  const s = scratch();
  s.file("crossroads-check-busy/deep/inner/log", 0.1);
  s.age("crossroads-check-busy/deep/inner", 48);
  s.age("crossroads-check-busy/deep", 48);
  s.age("crossroads-check-busy", 48);
  const r = s.run();
  assert.strictEqual(r.code, 0, r.out);
  assert.ok(s.exists("crossroads-check-busy/deep/inner/log"));
  assert.match(r.out, /removed 0, kept 1/);
});

test("removes stale loose files that match, and honours RETAIN_HOURS", () => {
  const s = scratch();
  s.file("crossroads-package-x.tgz", 5);
  assert.match(s.run().out, /removed 0/, "5 hours is inside the default 24");
  const r = s.run({ RETAIN_HOURS: "4" });
  assert.match(r.out, /removed 1/);
  assert.ok(!s.exists("crossroads-package-x.tgz"));
});

test("does not follow a symlink out of the scratch directory", () => {
  const s = scratch();
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "outside-"));
  fs.writeFileSync(path.join(outside, "keep"), "x");
  fs.symlinkSync(outside, path.join(s.tmp, "crossroads-link"));
  const t = now() - 48 * HOUR;
  fs.lutimesSync(path.join(s.tmp, "crossroads-link"), t, t);
  const r = s.run();
  assert.strictEqual(r.code, 0, r.out);
  assert.ok(fs.existsSync(path.join(outside, "keep")), "the link's target survives");
});

test("rejects a bad RETAIN_HOURS and a missing directory", () => {
  const s = scratch();
  assert.strictEqual(s.run({ RETAIN_HOURS: "0" }).code, 2);
  assert.strictEqual(s.run({ RETAIN_HOURS: "1d" }).code, 2);
  assert.strictEqual(s.run({ TMP_DIR: path.join(s.tmp, "missing") }).code, 2);
});

test("removes stale evolution embedded-Postgres folders by default", () => {
  const s = scratch();
  s.file("evolution-test-pg-AbC123/base/1/1259", 48);
  for (const d of ["evolution-test-pg-AbC123/base/1", "evolution-test-pg-AbC123/base", "evolution-test-pg-AbC123"]) s.age(d, 48);
  s.file("evolution-a11y-pg-Xy9/PG_VERSION", 48);
  s.age("evolution-a11y-pg-Xy9", 48);
  s.file("evolution-notes/keep", 48);
  s.age("evolution-notes", 48);
  const r = s.run();
  assert.strictEqual(r.code, 0, r.out);
  assert.ok(!s.exists("evolution-test-pg-AbC123"), r.out);
  assert.ok(!s.exists("evolution-a11y-pg-Xy9"), r.out);
  assert.ok(s.exists("evolution-notes"), "only *-pg-* folders, not every evolution-* name");
});

test("keeps a Postgres folder whose server is still running, however idle", async () => {
  const s = scratch();
  const dir = path.join(s.tmp, "evolution-test-pg-live");
  s.file("evolution-test-pg-live/PG_VERSION", 48);
  // A stand-in postmaster: a live process with this directory on its command
  // line, as Postgres has with -D <dir>.
  const { spawn } = require("node:child_process");
  const postmaster = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)", "--", "-D", dir], { stdio: "ignore" });
  try {
    fs.writeFileSync(path.join(dir, "postmaster.pid"), `${postmaster.pid}\n${dir}\n`);
    const t = now() - 48 * HOUR;
    fs.utimesSync(path.join(dir, "postmaster.pid"), t, t);
    s.age("evolution-test-pg-live", 48);
    // A dead one: a PID that cannot be running.
    s.file("evolution-test-pg-dead/postmaster.pid", 48);
    fs.writeFileSync(path.join(s.tmp, "evolution-test-pg-dead/postmaster.pid"), "2147483646\n");
    fs.utimesSync(path.join(s.tmp, "evolution-test-pg-dead/postmaster.pid"), t, t);
    s.age("evolution-test-pg-dead", 48);
    const r = s.run();
    assert.strictEqual(r.code, 0, r.out);
    assert.ok(s.exists("evolution-test-pg-live"), r.out);
    assert.ok(!s.exists("evolution-test-pg-dead"), r.out);
  } finally {
    postmaster.kill();
  }
});

test("removes a Postgres folder whose PID was reused by an unrelated process", () => {
  const s = scratch();
  // This test's own process is alive but is not this directory's postmaster.
  s.file("evolution-test-pg-reused/postmaster.pid", 48);
  fs.writeFileSync(path.join(s.tmp, "evolution-test-pg-reused/postmaster.pid"), `${process.pid}\n`);
  const t = now() - 48 * HOUR;
  fs.utimesSync(path.join(s.tmp, "evolution-test-pg-reused/postmaster.pid"), t, t);
  s.age("evolution-test-pg-reused", 48);
  const r = s.run();
  assert.strictEqual(r.code, 0, r.out);
  assert.ok(!s.exists("evolution-test-pg-reused"), r.out);
});
