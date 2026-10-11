// Tests for fleet-runner-clean.sh. The real script runs against a scratch
// directory standing in for /home/<user>/actions-runner, with file times set
// into the past and real git repositories for the branch pruning. Run with:
//
//   node --test runner-host/runner-clean.test.js
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const SCRIPT = path.join(__dirname, "fleet-runner-clean.sh");
const DAY = 86400;
const now = () => Math.floor(Date.now() / 1000);

const GIT_ENV = {
  GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com",
  GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com",
  GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null",
};
const git = (cwd, ...args) => {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", env: { PATH: process.env.PATH, ...GIT_ENV } });
  assert.strictEqual(r.status, 0, `git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
};

function scratch() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "runner-clean-"));
  const runner = path.join(home, "actions-runner");
  const work = path.join(runner, "_work");
  fs.mkdirSync(work, { recursive: true });
  const p = (rel) => path.join(work, rel);
  const exists = (abs) => fs.existsSync(abs);
  // Age a whole tree: every file and folder in it.
  const ageTree = (abs, days) => {
    const t = now() - days * DAY;
    const walk = (d) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        if (e.isDirectory()) walk(path.join(d, e.name)); else fs.utimesSync(path.join(d, e.name), t, t);
      }
      fs.utimesSync(d, t, t);
    };
    walk(abs);
  };
  const file = (abs, bytes = 2048) => {
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, "x".repeat(bytes));
  };
  const run = (env = {}) => {
    const r = spawnSync("bash", [SCRIPT], {
      encoding: "utf8",
      env: { PATH: process.env.PATH, RUNNER_DIRS: runner, BUSY_CMD: "false", DOCKER: "", POLL_SECONDS: "1", ...env },
    });
    return { code: r.status, out: r.stdout + r.stderr };
  };
  return { home, runner, work, p, exists, ageTree, file, run };
}

test("removes a stale checkout, keeps fresh ones, underscore folders and recently touched trees", () => {
  const s = scratch();
  s.file(s.p("old-repo/old-repo/package.json")); s.ageTree(s.p("old-repo"), 30);
  s.file(s.p("new-repo/new-repo/package.json")); s.ageTree(s.p("new-repo"), 1);
  s.file(s.p("_tool/node/20/bin")); s.ageTree(s.p("_tool"), 90);
  s.file(s.p("_actions/x/action.yml")); s.ageTree(s.p("_actions"), 90);
  // Old top folder, but a job is still writing deep inside it.
  s.file(s.p("busy-repo/busy-repo/deep/log")); s.ageTree(s.p("busy-repo"), 30);
  fs.utimesSync(s.p("busy-repo/busy-repo/deep/log"), now(), now());
  const r = s.run();
  assert.strictEqual(r.code, 0, r.out);
  assert.ok(!s.exists(s.p("old-repo")), r.out);
  assert.ok(s.exists(s.p("new-repo")));
  assert.ok(s.exists(s.p("_tool")), "the tool cache is not touched");
  assert.ok(s.exists(s.p("_actions")), "downloaded actions are not touched");
  assert.ok(s.exists(s.p("busy-repo/busy-repo/deep/log")));
  assert.match(r.out, /removed 1 folder/);
});

test("removes old _temp entries and honours the retention settings", () => {
  const s = scratch();
  s.file(s.p("_temp/old-step/file")); s.ageTree(s.p("_temp/old-step"), 10);
  s.file(s.p("_temp/new-step/file")); s.ageTree(s.p("_temp/new-step"), 2);
  const r = s.run();
  assert.ok(!s.exists(s.p("_temp/old-step")), r.out);
  assert.ok(s.exists(s.p("_temp/new-step")), "2 days is inside the default 3");
  const r2 = s.run({ TEMP_RETAIN_DAYS: "1" });
  assert.strictEqual(r2.code, 0, r2.out);
  assert.ok(!s.exists(s.p("_temp/new-step")), r2.out);
  assert.ok(s.exists(s.p("_temp")), "_temp itself stays");
});

test("prunes merged local branches only, never the current one, main or an unmerged branch", () => {
  const s = scratch();
  const repo = s.p("demo/demo");
  fs.mkdirSync(repo, { recursive: true });
  git(repo, "init", "-q", "-b", "main");
  s.file(path.join(repo, "a.txt"));
  git(repo, "add", "."); git(repo, "commit", "-q", "-m", "one");
  git(repo, "branch", "merged-feature");
  git(repo, "checkout", "-q", "-b", "unmerged");
  s.file(path.join(repo, "b.txt"));
  git(repo, "add", "."); git(repo, "commit", "-q", "-m", "two");
  git(repo, "checkout", "-q", "main");
  const r = s.run({ ...GIT_ENV });
  assert.strictEqual(r.code, 0, r.out);
  const branches = git(repo, "for-each-ref", "--format=%(refname:short)", "refs/heads").split("\n").sort();
  assert.deepStrictEqual(branches, ["main", "unmerged"], r.out);
  assert.match(r.out, /pruned 1 local branch/);
});

test("clears the npm cache only when it is over the limit", () => {
  const s = scratch();
  const cache = path.join(s.home, ".npm/_cacache");
  s.file(path.join(cache, "blob"), 3 * 1024 * 1024);
  assert.ok(s.run({ NPM_CACHE_MAX_MB: "10" }) && s.exists(cache), "3 MB is under a 10 MB limit");
  const r = s.run({ NPM_CACHE_MAX_MB: "1" });
  assert.strictEqual(r.code, 0, r.out);
  assert.ok(!s.exists(cache), r.out);
  assert.match(r.out, /cleared the npm cache/);
});

test("touches nothing when the host never goes idle, and says so", () => {
  const s = scratch();
  s.file(s.p("old-repo/old-repo/package.json")); s.ageTree(s.p("old-repo"), 30);
  const r = s.run({ BUSY_CMD: "true", WAIT_MINUTES: "0" });
  assert.strictEqual(r.code, 0, r.out);
  assert.ok(s.exists(s.p("old-repo")));
  assert.match(r.out, /WARNING: the host was not idle/);
});

test("stops the moment a job starts mid-run", () => {
  const s = scratch();
  // Idle for the first check (the wait loop), busy afterwards: a marker file
  // flips the answer, as a job starting would.
  const marker = path.join(s.home, "seen-idle");
  const busy = path.join(s.home, "busy.sh");
  fs.writeFileSync(busy, `#!/bin/sh\nif [ -e "${marker}" ]; then exit 0; fi\ntouch "${marker}"\nexit 1\n`, { mode: 0o755 });
  s.file(s.p("old-repo/old-repo/package.json")); s.ageTree(s.p("old-repo"), 30);
  const r = s.run({ BUSY_CMD: busy });
  assert.strictEqual(r.code, 0, r.out);
  assert.ok(s.exists(s.p("old-repo")), "nothing is removed once a job is running");
  assert.match(r.out, /a job started; stopping here/);
});

test("rejects a bad setting", () => {
  const s = scratch();
  assert.strictEqual(s.run({ WORK_RETAIN_DAYS: "0" }).code, 2);
  assert.strictEqual(s.run({ NPM_CACHE_MAX_MB: "4g" }).code, 2);
});
