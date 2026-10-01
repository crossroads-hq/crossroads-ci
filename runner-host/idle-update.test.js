// Tests for fleet-idle-update.sh. The real script runs against stub systemctl,
// apt-get and busy-check commands that record what they were asked to do, with
// a fake clock (NOW) stepped through each scenario. Run with:
//
//   node --test runner-host/idle-update.test.js
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const SCRIPT = path.join(__dirname, "fleet-idle-update.sh");
const UNITS = ["actions.runner.crossroads-hq.wsl-fleet-1.service", "actions.runner.crossroads-hq.wsl-fleet-2.service"];

function host({ aptFails = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "idle-update-"));
  const bin = path.join(dir, "bin");
  fs.mkdirSync(bin);
  const calls = path.join(dir, "calls");
  fs.writeFileSync(calls, "");
  const stub = (name, body) =>
    fs.writeFileSync(path.join(bin, name), `#!/usr/bin/env bash\necho "${name} $*" >> "${calls}"\n${body}\n`, { mode: 0o755 });
  stub("systemctl", `[ "$1" = list-units ] && printf '%s loaded active running x\\n' ${UNITS.join(" ")}; exit 0`);
  stub("apt-get", aptFails ? 'exit 100' : 'exit 0');
  // Busy answers come from a queue file, one line per call, so a scenario can
  // say "idle, then busy" for the last-moment re-check. Empty queue = idle.
  const queue = path.join(dir, "busy-queue");
  fs.writeFileSync(queue, "");
  stub("busy", `line="$(head -n1 "${queue}")"; tail -n +2 "${queue}" > "${queue}.t"; mv "${queue}.t" "${queue}"; [ "$line" = busy ]`);
  const state = path.join(dir, "state");

  const run = (now, busy = []) => {
    fs.writeFileSync(queue, busy.join("\n") + (busy.length ? "\n" : ""));
    const r = spawnSync("bash", [SCRIPT], {
      encoding: "utf8",
      env: {
        PATH: `${bin}${path.delimiter}${process.env.PATH}`,
        NOW: String(now), STATE_DIR: state, IDLE_MINUTES: "30", MIN_INTERVAL_HOURS: "24", STALE_WARN_DAYS: "7",
        SYSTEMCTL: path.join(bin, "systemctl"), APT_GET: path.join(bin, "apt-get"),
        BUSY_CMD: path.join(bin, "busy"), TIMEOUT_CMD: "", REBOOT_FLAG: path.join(dir, "reboot-required"),
      },
    });
    return { code: r.status, out: r.stdout + r.stderr };
  };
  const log = () => fs.readFileSync(calls, "utf8").trim().split("\n").filter(Boolean);
  const reset = () => fs.writeFileSync(calls, "");
  const has = (f) => fs.existsSync(path.join(state, f)) && fs.readFileSync(path.join(state, f), "utf8").trim();
  const updated = () => log().some((l) => l.endsWith(" upgrade"));
  return { dir, run, log, reset, has, updated, setState: (f, v) => { fs.mkdirSync(state, { recursive: true }); fs.writeFileSync(path.join(state, f), `${v}\n`); } };
}

const T0 = 1_700_000_000;
const MIN = 60;

test("a busy host never updates and keeps no idle clock", () => {
  const h = host();
  assert.equal(h.run(T0, ["busy"]).code, 0);
  assert.equal(h.has("idle-since"), false);
  assert.equal(h.updated(), false);
});

test("the first idle observation only starts the clock", () => {
  const h = host();
  assert.equal(h.run(T0).code, 0);
  assert.equal(h.has("idle-since"), String(T0));
  assert.equal(h.updated(), false);
});

test("idle for less than IDLE_MINUTES does not update", () => {
  const h = host();
  h.run(T0);
  h.run(T0 + 29 * MIN);
  assert.equal(h.updated(), false);
});

test("a job in between resets the clock, so idle must be unbroken", () => {
  const h = host();
  h.run(T0);
  h.run(T0 + 20 * MIN, ["busy"]);
  assert.equal(h.has("idle-since"), false);
  h.run(T0 + 25 * MIN);             // clock restarts here
  h.run(T0 + 40 * MIN);             // 15 min since restart: not yet
  assert.equal(h.updated(), false);
  h.run(T0 + 56 * MIN);             // 31 min unbroken
  assert.equal(h.updated(), true);
});

test("after IDLE_MINUTES of idle it pauses the runners, updates, and resumes them", () => {
  const h = host();
  h.run(T0);
  h.reset();
  assert.equal(h.run(T0 + 30 * MIN).code, 0);
  const calls = h.log();
  const stop = calls.findIndex((l) => l.startsWith("systemctl stop"));
  const update = calls.findIndex((l) => l.endsWith(" update"));
  const upgrade = calls.findIndex((l) => l.endsWith(" upgrade"));
  const start = calls.findIndex((l) => l.startsWith("systemctl start"));
  assert.ok(stop >= 0 && stop < update && update < upgrade && upgrade < start, calls.join("\n"));
  assert.equal(calls[stop], `systemctl stop ${UNITS.join(" ")}`);
  assert.equal(calls[start], `systemctl start ${UNITS.join(" ")}`);
  assert.equal(h.has("last-success"), String(T0 + 30 * MIN));
  assert.equal(h.has("idle-since"), false);
});

test("a job that starts at the last moment cancels the update", () => {
  const h = host();
  h.run(T0);
  h.run(T0 + 31 * MIN, ["idle", "busy"]);  // first check idle, re-check busy
  assert.equal(h.updated(), false);
  assert.equal(h.log().some((l) => l.startsWith("systemctl stop")), false);
  assert.equal(h.has("idle-since"), false);
});

test("a failed update still resumes the runners and records no success", () => {
  const h = host({ aptFails: true });
  h.run(T0);
  const r = h.run(T0 + 30 * MIN);
  assert.notEqual(r.code, 0);
  assert.ok(h.log().some((l) => l.startsWith("systemctl start")), "runners must restart after a failure");
  assert.equal(h.has("last-success"), false);
});

test("it updates at most once per MIN_INTERVAL_HOURS", () => {
  const h = host();
  h.setState("last-success", T0);
  h.run(T0 + 1 * 3600);
  h.run(T0 + 23 * 3600);
  assert.equal(h.has("idle-since"), false, "not due: no clock kept");
  assert.equal(h.updated(), false);
});

test("a host that never stays idle long enough is warned about", () => {
  const h = host();
  h.setState("last-success", T0);
  const r = h.run(T0 + 8 * 86400, ["busy"]);
  assert.match(r.out, /WARNING: last update was 8 days ago/);
});

test("a pending reboot is reported, never performed", () => {
  const h = host();
  fs.writeFileSync(path.join(h.dir, "reboot-required"), "");
  h.run(T0);
  const r = h.run(T0 + 30 * MIN);
  assert.match(r.out, /requires a reboot/);
  assert.equal(h.log().some((l) => /reboot|shutdown/.test(l)), false);
});
