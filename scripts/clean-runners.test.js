// Tests for clean-runners.sh, against a stub `gh` that answers from a fixture
// map and records every DELETE. Run with:
//
//   node --test scripts/clean-runners.test.js
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const SCRIPT = path.join(__dirname, "clean-runners.sh");
const STUB = `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
if (args[0] === "auth") process.exit(0);
const endpoint = args.find((a) => a.startsWith("repos/") || a.startsWith("orgs/"));
if (args.includes("DELETE")) { fs.appendFileSync(process.env.DELETE_LOG, endpoint + "\\n"); process.exit(0); }
const fixture = JSON.parse(fs.readFileSync(process.env.FIXTURE, "utf8"));
if (!(endpoint in fixture)) { console.error("stub: no fixture for " + endpoint); process.exit(1); }
process.stdout.write(JSON.stringify(fixture[endpoint]));
`;

const runner = (id, name, status, busy = false) => ({ id, name, status, busy, labels: [{ name: "self-hosted" }, { name: "fast" }] });
const page = (...runners) => [{ total_count: runners.length, runners }];

function scratch(fixture) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clean-runners-"));
  const gh = path.join(dir, "gh");
  fs.writeFileSync(gh, STUB, { mode: 0o755 });
  const fixtureFile = path.join(dir, "fixture.json");
  fs.writeFileSync(fixtureFile, JSON.stringify(fixture));
  const roster = path.join(dir, "repositories.txt");
  fs.writeFileSync(roster, "# comment\ncrossroads-hq/demo  full  main\n");
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

const ORG = "orgs/crossroads-hq/actions/runners?per_page=100";
const REPO = "repos/crossroads-hq/demo/actions/runners?per_page=100";

test("dry run lists an offline runner and removes nothing", () => {
  const s = scratch({ [ORG]: page(runner(1, "ok", "online"), runner(2, "gone", "offline")), [REPO]: page() });
  const r = s.run();
  assert.strictEqual(r.code, 0, r.out);
  assert.match(r.out, /would remove offline runner gone/);
  assert.deepStrictEqual(r.deletes, []);
});

test("APPLY=1 removes offline runners at the scope that owns them, once", () => {
  const s = scratch({
    [ORG]: page(runner(1, "ok", "online"), runner(2, "org-gone", "offline")),
    // The repository listing also shows the organization's runners.
    [REPO]: page(runner(1, "ok", "online"), runner(2, "org-gone", "offline"), runner(3, "repo-gone", "offline")),
  });
  const r = s.run({ APPLY: "1" });
  assert.strictEqual(r.code, 0, r.out);
  assert.deepStrictEqual(r.deletes, [
    "orgs/crossroads-hq/actions/runners/2",
    "repos/crossroads-hq/demo/actions/runners/3",
  ]);
});

test("never removes a busy runner", () => {
  const s = scratch({ [ORG]: page(runner(1, "ok", "online"), runner(2, "busy", "offline", true)), [REPO]: page() });
  assert.deepStrictEqual(s.run({ APPLY: "1" }).deletes, []);
});

test("removes nothing from a scope where every runner is offline", () => {
  const s = scratch({ [ORG]: page(runner(1, "a", "offline"), runner(2, "b", "offline")), [REPO]: page() });
  const r = s.run({ APPLY: "1" });
  assert.strictEqual(r.code, 0, r.out);
  assert.match(r.out, /the fleet looks down/);
  assert.deepStrictEqual(r.deletes, []);
});

test("an unreadable listing is an error and removes nothing there", () => {
  const s = scratch({ [ORG]: { message: "Resource not accessible" }, [REPO]: page(runner(3, "x", "online")) });
  const r = s.run({ APPLY: "1" });
  assert.strictEqual(r.code, 1, r.out);
  assert.match(r.out, /cannot read the runner list in full/);
  assert.deepStrictEqual(r.deletes, []);
});
