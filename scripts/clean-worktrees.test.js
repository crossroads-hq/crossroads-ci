// Tests for clean-worktrees.sh, against real temporary git repositories with
// real worktrees and a local bare repository as `origin`. Run with:
//
//   node --test scripts/clean-worktrees.test.js
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const SCRIPT = path.join(__dirname, "clean-worktrees.sh");
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

// A repo with `origin`, one commit on main, and helpers to add worktrees.
function scratch() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "clean-wt-")));
  const bare = path.join(dir, "origin.git");
  const repo = path.join(dir, "code", "demo");
  fs.mkdirSync(path.dirname(repo), { recursive: true });
  git(dir, "init", "-q", "--bare", "-b", "main", bare);
  git(dir, "clone", "-q", bare, repo);
  git(repo, "checkout", "-q", "-b", "main");
  fs.writeFileSync(path.join(repo, "a.txt"), "a");
  git(repo, "add", "."); git(repo, "commit", "-q", "-m", "one");
  git(repo, "push", "-q", "-u", "origin", "main");
  git(repo, "remote", "set-head", "origin", "main");

  const wt = (name) => path.join(dir, "trees", name);
  // A pushed branch with a commit of its own, checked out in a worktree.
  const pushedBranch = (name) => {
    git(repo, "worktree", "add", "-q", "-b", name, wt(name));
    fs.writeFileSync(path.join(wt(name), `${name.replace(/\//g, "_")}.txt`), name);
    git(wt(name), "add", "."); git(wt(name), "commit", "-q", "-m", name);
    git(wt(name), "push", "-q", "-u", "origin", name);
  };
  // The remote branch deleted, as delete-on-merge does.
  const deleteRemote = (name) => git(bare, "branch", "-D", name);
  const run = (env = {}, { cwd = dir, roots = [path.join(dir, "code")] } = {}) => {
    const r = spawnSync("bash", [SCRIPT, ...roots], { cwd, encoding: "utf8", env: { PATH: process.env.PATH, ...GIT_ENV, ...env } });
    return { code: r.status, out: r.stdout + r.stderr };
  };
  const branches = () => git(repo, "for-each-ref", "--format=%(refname:short)", "refs/heads").split("\n");
  return { dir, bare, repo, wt, pushedBranch, deleteRemote, run, branches, exists: fs.existsSync };
}

test("dry run lists a worktree whose remote branch is gone and changes nothing", () => {
  const s = scratch();
  s.pushedBranch("claude/done");
  s.deleteRemote("claude/done");
  const r = s.run();
  assert.strictEqual(r.code, 0, r.out);
  assert.match(r.out, /plan\s+would remove .*claude\/done.*its remote branch is gone/);
  assert.ok(s.exists(s.wt("claude/done")));
  assert.match(r.out, /Dry run: 1 removable/);
});

test("APPLY=1 removes a worktree whose remote branch is gone, and its merged branch", () => {
  const s = scratch();
  s.pushedBranch("done");
  // Merged into main by a merge commit, then the remote branch deleted.
  git(s.repo, "merge", "-q", "--no-ff", "-m", "merge", "done");
  git(s.repo, "push", "-q", "origin", "main");
  s.deleteRemote("done");
  const r = s.run({ APPLY: "1" });
  assert.strictEqual(r.code, 0, r.out);
  assert.ok(!s.exists(s.wt("done")), r.out);
  assert.ok(!s.branches().includes("done"), r.out);
  assert.match(r.out, /removed .* and branch 'done' \(was [0-9a-f]{40}/);
});

test("a squash-merged branch loses its worktree but keeps its branch, and says so", () => {
  const s = scratch();
  s.pushedBranch("squashed");
  s.deleteRemote("squashed");
  const r = s.run({ APPLY: "1" });
  assert.strictEqual(r.code, 0, r.out);
  assert.ok(!s.exists(s.wt("squashed")), r.out);
  assert.ok(s.branches().includes("squashed"), "git branch -d refuses it, so it stays");
  assert.match(r.out, /branch 'squashed' kept, git does not consider it merged/);
});

test("a branch merged into the default branch with no upstream is removable", () => {
  const s = scratch();
  git(s.repo, "worktree", "add", "-q", "-b", "local-only", s.wt("local-only"));
  fs.writeFileSync(path.join(s.wt("local-only"), "l.txt"), "l");
  git(s.wt("local-only"), "add", "."); git(s.wt("local-only"), "commit", "-q", "-m", "l");
  git(s.repo, "merge", "-q", "--no-ff", "-m", "merge", "local-only");
  git(s.repo, "push", "-q", "origin", "main");
  const r = s.run();
  assert.match(r.out, /would remove .*local-only.*merged into origin\/main/);
});

test("keeps a fresh branch sitting at the default tip", () => {
  const s = scratch();
  git(s.repo, "worktree", "add", "-q", "-b", "fresh", s.wt("fresh"));
  const r = s.run({ APPLY: "1" });
  assert.ok(s.exists(s.wt("fresh")), r.out);
  assert.match(r.out, /keep .*fresh.*not finished/);
});

test("keeps an unmerged branch whose upstream still exists", () => {
  const s = scratch();
  s.pushedBranch("wip");
  const r = s.run({ APPLY: "1" });
  assert.ok(s.exists(s.wt("wip")), r.out);
  assert.match(r.out, /keep .*wip.*not finished/);
});

test("keeps a worktree with uncommitted or untracked files", () => {
  const s = scratch();
  s.pushedBranch("dirty");
  s.deleteRemote("dirty");
  fs.writeFileSync(path.join(s.wt("dirty"), "scratch.txt"), "notes");
  const r = s.run({ APPLY: "1" });
  assert.ok(s.exists(s.wt("dirty")), r.out);
  assert.match(r.out, /keep .*dirty.*uncommitted or untracked/);
});

test("keeps a locked worktree", () => {
  const s = scratch();
  s.pushedBranch("locked");
  s.deleteRemote("locked");
  git(s.repo, "worktree", "lock", s.wt("locked"));
  const r = s.run({ APPLY: "1" });
  assert.ok(s.exists(s.wt("locked")), r.out);
  assert.match(r.out, /keep .*locked.*\(locked\)/);
});

test("reports a detached worktree and never removes it", () => {
  const s = scratch();
  git(s.repo, "worktree", "add", "-q", "--detach", s.wt("detached"));
  const r = s.run({ APPLY: "1" });
  assert.ok(s.exists(s.wt("detached")), r.out);
  assert.match(r.out, /keep .*detached.*detached HEAD/);
});

test("lists a worktree whose folder is gone and prunes nothing", () => {
  const s = scratch();
  s.pushedBranch("moved");
  fs.rmSync(s.wt("moved"), { recursive: true });
  const r = s.run({ APPLY: "1" });
  assert.match(r.out, /missing .*moved.*worktree prune/);
  assert.match(git(s.repo, "worktree", "list"), /moved/, "the worktree record is left for the user to prune");
});

test("never removes the folder it was started from", () => {
  const s = scratch();
  s.pushedBranch("here");
  s.deleteRemote("here");
  const r = s.run({ APPLY: "1" }, { cwd: path.join(s.wt("here")) });
  assert.ok(s.exists(s.wt("here")), r.out);
  assert.match(r.out, /keep .*here.*you are in it/);
});

test("a repository whose origin cannot be fetched is skipped and fails the run", () => {
  const s = scratch();
  s.pushedBranch("done");
  s.deleteRemote("done");
  fs.renameSync(s.bare, `${s.bare}.moved`);
  const r = s.run({ APPLY: "1" });
  assert.strictEqual(r.code, 1, r.out);
  assert.ok(s.exists(s.wt("done")), "nothing is removed when 'gone' cannot be told from 'offline'");
  assert.match(r.out, /cannot fetch origin; skipped/);
});

test("finds repositories under a root and ignores node_modules", () => {
  const s = scratch();
  s.pushedBranch("done");
  s.deleteRemote("done");
  const hidden = path.join(s.dir, "code", "node_modules", "pkg");
  fs.mkdirSync(hidden, { recursive: true });
  git(hidden, "init", "-q");
  const r = s.run();
  assert.strictEqual(r.code, 0, r.out);
  assert.doesNotMatch(r.out, /node_modules/);
  assert.match(r.out, /would remove/);
});
