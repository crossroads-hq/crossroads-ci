// Tests for clean-branches.sh. The real script runs against a stub `gh` that
// answers from a fixture map and records every DELETE. Run with:
//
//   node --test scripts/clean-branches.test.js
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const SCRIPT = path.join(__dirname, "clean-branches.sh");
const REPO = "crossroads-hq/demo";

// The stub: argv holds an endpoint ("repos/...") or `auth status`. Paginated
// endpoints answer with a list of pages, as `gh api --paginate --slurp` does.
const STUB = `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
if (args[0] === "auth") process.exit(0);
const endpoint = args.find((a) => a.startsWith("repos/"));
const fixture = JSON.parse(fs.readFileSync(process.env.FIXTURE, "utf8"));
if (args.includes("DELETE")) {
  fs.appendFileSync(process.env.DELETE_LOG, endpoint + "\\n");
  process.exit(fixture.__deleteFails === endpoint ? 1 : 0);
}
if (!(endpoint in fixture)) { console.error("stub: no fixture for " + endpoint); process.exit(1); }
process.stdout.write(JSON.stringify(fixture[endpoint]));
`;

const branch = (name, sha, protectedBranch = false) => ({ name, protected: protectedBranch, commit: { sha } });
const pr = (number, sha, { state = "closed", merged = true, repo = REPO } = {}) => ({
  number, state, merged_at: merged ? "2026-10-01T00:00:00Z" : null, head: { sha, repo: { full_name: repo } },
});
const prsFor = (name) => `repos/${REPO}/pulls?state=all&head=${encodeURIComponent(`crossroads-hq:${name}`)}&per_page=100`;

function scratch({ branches, open = [], closedByBranch = {}, extra = {}, omit = [], rosterBranch = "main" }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clean-branches-"));
  const gh = path.join(dir, "gh");
  fs.writeFileSync(gh, STUB, { mode: 0o755 });
  const fixture = {
    [`repos/${REPO}`]: { default_branch: "main" },
    [`repos/${REPO}/branches?per_page=100`]: [branches],
    [`repos/${REPO}/pulls?state=open&per_page=100`]: [open],
    ...extra,
  };
  for (const [name, prs] of Object.entries(closedByBranch)) fixture[prsFor(name)] = [prs];
  // Any branch without an entry has no pull request at all.
  for (const b of branches) if (!(prsFor(b.name) in fixture)) fixture[prsFor(b.name)] = [[]];
  for (const endpoint of omit) delete fixture[endpoint];
  const fixtureFile = path.join(dir, "fixture.json");
  fs.writeFileSync(fixtureFile, JSON.stringify(fixture));
  const roster = path.join(dir, "repositories.txt");
  fs.writeFileSync(roster, `# comment\n\n${REPO}  full  ${rosterBranch}\n`);
  const deleteLog = path.join(dir, "deletes.log");
  const run = (env = {}) => {
    const r = spawnSync("bash", [SCRIPT, roster], {
      encoding: "utf8",
      env: { PATH: process.env.PATH, GH: gh, GH_TOKEN: "x", FIXTURE: fixtureFile, DELETE_LOG: deleteLog, ...env },
    });
    const deletes = fs.existsSync(deleteLog) ? fs.readFileSync(deleteLog, "utf8").split("\n").filter(Boolean) : [];
    return { code: r.status, out: r.stdout + r.stderr, deletes };
  };
  return { run };
}

test("dry run lists a merged branch and deletes nothing", () => {
  const s = scratch({
    branches: [branch("main", "m1"), branch("claude/done", "d1")],
    closedByBranch: { "claude/done": [pr(7, "d1")] },
  });
  const r = s.run();
  assert.strictEqual(r.code, 0, r.out);
  assert.match(r.out, /would delete crossroads-hq\/demo:claude\/done \(d1\), pull request #7 merged/);
  assert.deepStrictEqual(r.deletes, []);
  assert.match(r.out, /Dry run: would delete 1, kept 1/);
});

test("APPLY=1 deletes the merged branch and only that", () => {
  const s = scratch({
    branches: [branch("main", "m1"), branch("claude/done", "d1"), branch("feature/wip", "w1")],
    closedByBranch: { "claude/done": [pr(7, "d1")] },
  });
  const r = s.run({ APPLY: "1" });
  assert.strictEqual(r.code, 0, r.out);
  assert.deepStrictEqual(r.deletes, [`repos/${REPO}/git/refs/heads/claude/done`]);
  assert.match(r.out, /deleted crossroads-hq\/demo:claude\/done \(d1\)/);
});

test("keeps the default and roster branches, protected, queue and open-PR branches", () => {
  const s = scratch({
    branches: [
      branch("main", "m1"), branch("develop", "v1"), branch("release", "r1", true),
      branch("gh-readonly-queue/main/pr-1", "q1"), branch("claude/open", "o1"),
    ],
    open: [{ number: 9, head: { ref: "claude/open", sha: "o1" } }],
    closedByBranch: {
      develop: [pr(1, "v1")], "gh-readonly-queue/main/pr-1": [pr(2, "q1")], "claude/open": [pr(3, "o1")],
    },
    rosterBranch: "develop",
  });
  const r = s.run({ APPLY: "1" });
  assert.strictEqual(r.code, 0, r.out);
  assert.deepStrictEqual(r.deletes, []);
});

test("keeps a branch with no pull request, however it compares", () => {
  const s = scratch({ branches: [branch("main", "m1"), branch("fresh", "m1")] });
  const r = s.run({ APPLY: "1" });
  assert.strictEqual(r.code, 0, r.out);
  assert.deepStrictEqual(r.deletes, []);
});

test("keeps a branch pushed to after its pull request closed", () => {
  const s = scratch({
    branches: [branch("main", "m1"), branch("claude/more", "new-tip")],
    closedByBranch: { "claude/more": [pr(4, "old-tip")] },
  });
  const r = s.run({ APPLY: "1" });
  assert.deepStrictEqual(r.deletes, []);
});

test("ignores a closed pull request from a fork that merely shares the branch name", () => {
  const s = scratch({
    branches: [branch("main", "m1"), branch("patch-1", "p1")],
    closedByBranch: { "patch-1": [pr(5, "p1", { repo: "someone/demo" })] },
  });
  const r = s.run({ APPLY: "1" });
  assert.deepStrictEqual(r.deletes, []);
});

test("a closed unmerged pull request with an unchanged head counts, and says so", () => {
  const s = scratch({
    branches: [branch("main", "m1"), branch("claude/abandoned", "a1")],
    closedByBranch: { "claude/abandoned": [pr(6, "a1", { merged: false })] },
  });
  const r = s.run({ APPLY: "1" });
  assert.deepStrictEqual(r.deletes, [`repos/${REPO}/git/refs/heads/claude/abandoned`]);
  assert.match(r.out, /pull request #6 closed, head unchanged/);
});

test("an unreadable branch list is an error and deletes nothing", () => {
  // Not a list of pages: an error body, as a failed request can leave behind.
  const bad = scratch({ branches: [branch("main", "m1")], extra: { [`repos/${REPO}/branches?per_page=100`]: { message: "boom" } } });
  const r = bad.run({ APPLY: "1" });
  assert.strictEqual(r.code, 1, r.out);
  assert.match(r.out, /cannot read the branch list in full/);
  assert.deepStrictEqual(r.deletes, []);
});

test("a branch whose pull requests cannot be read is kept and fails the run", () => {
  // With the per-branch fixture gone the stub exits 1 for that request.
  const broken = scratch({
    branches: [branch("main", "m1"), branch("claude/x", "x1")],
    omit: [prsFor("claude/x")],
  });
  const r = broken.run({ APPLY: "1" });
  assert.strictEqual(r.code, 1, r.out);
  assert.match(r.out, /cannot classify branch 'claude\/x'/);
  assert.deepStrictEqual(r.deletes, []);
});

test("more deletable branches than MAX_DELETE deletes none of them", () => {
  const names = ["a", "b", "c"].map((n) => `claude/${n}`);
  const s = scratch({
    branches: [branch("main", "m1"), ...names.map((n, i) => branch(n, `s${i}`))],
    closedByBranch: Object.fromEntries(names.map((n, i) => [n, [pr(10 + i, `s${i}`)]])),
  });
  const r = s.run({ APPLY: "1", MAX_DELETE: "2" });
  assert.strictEqual(r.code, 1, r.out);
  assert.match(r.out, /more than MAX_DELETE=2/);
  assert.deepStrictEqual(r.deletes, []);
});

test("a failed deletion fails the run", () => {
  const s = scratch({
    branches: [branch("main", "m1"), branch("claude/done", "d1")],
    closedByBranch: { "claude/done": [pr(7, "d1")] },
    extra: { __deleteFails: `repos/${REPO}/git/refs/heads/claude/done` },
  });
  const r = s.run({ APPLY: "1" });
  assert.strictEqual(r.code, 1, r.out);
  assert.match(r.out, /could not delete 'claude\/done'/);
});
