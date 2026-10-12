// Tests for install-macos-daemon.sh. The real script runs with stand-ins for the
// macOS tools (uname, launchctl, plutil, chown) and ROOT pointing at a scratch
// directory, so nothing outside it is touched. Run with:
//
//   node --test runner-host/install-macos-daemon.test.js
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const SCRIPT = path.join(__dirname, "install-macos-daemon.sh");
const LABEL = "com.crossroads.fleet-runner-clean.daemon";
// The installer insists on root, as a LaunchDaemon install must. A stand-in `id`
// answers "root" to `id -u` so these tests run, and assert, as any user; every
// other `id` call goes to the real one.
const isRoot = true;

function scratch(uname = "Darwin") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "daemon-install-"));
  const bin = path.join(dir, "bin");
  fs.mkdirSync(bin);
  const calls = path.join(dir, "calls.log");
  const stub = (name, body) => fs.writeFileSync(path.join(bin, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  stub("uname", `echo ${uname}`);
  stub("id", `if [ "$1" = "-u" ] && [ $# -eq 1 ]; then echo 0; else exec /usr/bin/id "$@"; fi`);
  // `launchctl print` reports "not loaded", so the installer does not wait on bootout.
  stub("launchctl", `echo "launchctl $*" >> "${calls}"\n[ "$1" = "print" ] && exit 1\nexit 0`);
  stub("plutil", "exit 0");
  stub("chown", `echo "chown $*" >> "${calls}"`);
  const root = path.join(dir, "root");
  const run = (args = [], env = {}) => {
    const r = spawnSync("bash", [SCRIPT, ...args], {
      encoding: "utf8",
      env: { PATH: `${bin}:${process.env.PATH}`, ROOT: root, ...env },
    });
    return { code: r.status, out: r.stdout + r.stderr };
  };
  const plist = () => fs.readFileSync(path.join(root, "Library/LaunchDaemons", `${LABEL}.plist`), "utf8");
  const callLog = () => (fs.existsSync(calls) ? fs.readFileSync(calls, "utf8") : "");
  return { root, run, plist, callLog };
}

test("refuses off macOS", { skip: !isRoot }, () => {
  const r = scratch("Linux").run([], { RUNNER_USER: "nobody" });
  assert.strictEqual(r.code, 1);
  assert.match(r.out, /for macOS/);
});

test("requires RUNNER_USER, and refuses root or an unknown user", { skip: !isRoot }, () => {
  const s = scratch();
  assert.match(s.run().out, /set RUNNER_USER/);
  assert.match(s.run([], { RUNNER_USER: "root" }).out, /must not be root/);
  assert.match(s.run([], { RUNNER_USER: "no-such-user-xyz" }).out, /no such user/);
  assert.match(s.run([], { RUNNER_USER: "bad;name" }).out, /characters/);
});

test("installs a root-owned script and a plist that runs as the runner user", { skip: !isRoot }, () => {
  const s = scratch();
  const r = s.run([], { RUNNER_USER: "nobody", WORK_RETAIN_DAYS: "21", DOCKER: "" });
  assert.strictEqual(r.code, 0, r.out);
  const p = s.plist();
  assert.match(p, /<key>UserName<\/key><string>nobody<\/string>/);
  assert.match(p, /<string>\/usr\/local\/libexec\/crossroads-ci\/fleet-runner-clean<\/string>/);
  assert.match(p, /<key>Weekday<\/key><integer>0<\/integer>/);
  assert.match(p, /<key>Hour<\/key><integer>4<\/integer>/);
  assert.match(p, /<key>RUNNER_DIRS<\/key><string>\/Users\/nobody\/actions-runner\*<\/string>/);
  assert.match(p, /<key>WORK_RETAIN_DAYS<\/key><string>21<\/string>/);
  assert.match(p, /<key>DOCKER<\/key><string><\/string>/, "an empty DOCKER is kept, which switches the prune off");
  assert.ok(fs.existsSync(path.join(s.root, "usr/local/libexec/crossroads-ci/fleet-runner-clean")));
  const calls = s.callLog();
  assert.match(calls, /launchctl bootstrap system .*\.plist/);
  assert.match(calls, /chown root:wheel .*\.plist/, "launchd needs a root-owned plist");
  assert.match(calls, /chown root:wheel .*fleet-runner-clean/, "the runner user must not own the script that runs for it");
  assert.match(calls, /chown root:wheel .*\/var\/log\/crossroads-ci\n/, "the log directory stays root-owned");
  assert.match(calls, /chown nobody .*daemon\.log/, "only the log file belongs to the runner user");
});

test("warns when the default RUNNER_DIRS matches nothing", () => {
  const r = scratch().run([], { RUNNER_USER: "nobody" });
  assert.strictEqual(r.code, 0, r.out);
  assert.match(r.out, /WARNING: nothing matches RUNNER_DIRS/);
});

test("does not wait on bootout when the job is not loaded", () => {
  const started = Date.now();
  scratch().run([], { RUNNER_USER: "nobody" });
  assert.ok(Date.now() - started < 5000);
});

test("a custom RUNNER_DIRS replaces the default", { skip: !isRoot }, () => {
  const s = scratch();
  s.run([], { RUNNER_USER: "nobody", RUNNER_DIRS: "/Volumes/ci/actions-runner*" });
  assert.match(s.plist(), /<key>RUNNER_DIRS<\/key><string>\/Volumes\/ci\/actions-runner\*<\/string>/);
});

test("--uninstall boots the job out and removes what it installed", { skip: !isRoot }, () => {
  const s = scratch();
  s.run([], { RUNNER_USER: "nobody" });
  const r = s.run(["--uninstall"]);
  assert.strictEqual(r.code, 0, r.out);
  assert.ok(!fs.existsSync(path.join(s.root, "Library/LaunchDaemons", `${LABEL}.plist`)));
  assert.ok(!fs.existsSync(path.join(s.root, "usr/local/libexec/crossroads-ci/fleet-runner-clean")));
  assert.match(s.callLog(), /launchctl bootout system\/com\.crossroads\.fleet-runner-clean\.daemon/);
});
