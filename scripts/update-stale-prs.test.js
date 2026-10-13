// Tests for update-stale-prs.sh. The real script runs against a stub `gh` that
// answers from a fixture and records every update, label change and comment.
// Run with:
//
//   node --test scripts/update-stale-prs.test.js
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const SCRIPT = path.join(__dirname, "update-stale-prs.sh");
const REPO = "crossroads-hq/demo";

// The stub answers the five calls the script makes and appends one line per
// write to CALL_LOG: "PUT <n>", "EDIT <n>", "COMMENT <n>".
const STUB = `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
const fixture = JSON.parse(fs.readFileSync(process.env.FIXTURE, "utf8"));
const log = (line) => fs.appendFileSync(process.env.CALL_LOG, line + "\\n");
const endpoint = args.find((a) => a.startsWith("repos/"));
if (args[0] === "pr" && args[1] === "list") {
  process.stdout.write(JSON.stringify(fixture.prs));
} else if (args[0] === "pr" && (args[1] === "edit" || args[1] === "comment")) {
  log(args[1].toUpperCase() + " " + args[2]);
} else if (args[0] === "label") {
  // Creating the needs-rebase label: nothing to record.
} else if (args[0] === "api" && args.includes("PUT")) {
  const number = endpoint.split("/")[4];
  log("PUT " + number);
  const outcome = fixture.update[number] || "ok";
  if (outcome === "conflict") { console.error("Merge conflict (HTTP 422)"); process.exit(1); }
  if (outcome === "moved") { console.error("expected head sha didn't match (HTTP 422)"); process.exit(1); }
  if (outcome === "error") { console.error("boom (HTTP 500)"); process.exit(1); }
} else if (args[0] === "api" && endpoint && endpoint.includes("/compare/")) {
  const sha = endpoint.split("...")[1];
  process.stdout.write(String(fixture.behind[sha]));
} else if (args[0] === "api" && endpoint && endpoint.endsWith("/comments")) {
  // No earlier conflict notice.
} else {
  console.error("stub: unexpected call " + args.join(" "));
  process.exit(1);
}
`;

// An auto-merge pull request. `enabled` orders them; `checks` is the rollup.
const pr = (number, { enabled, behind = 3, checks = [], draft = false, fork = false, auto = true, labels = [] } = {}) => ({
  number,
  isDraft: draft,
  isCrossRepository: fork,
  autoMergeRequest: auto ? { enabledAt: enabled || `2026-10-12T10:${String(number % 60).padStart(2, "0")}:00Z` } : null,
  headRefOid: `sha${number}`,
  labels: labels.map((name) => ({ name })),
  statusCheckRollup: checks,
  __behind: behind,
});
const red = [{ __typename: "CheckRun", name: "Validate", status: "COMPLETED", conclusion: "FAILURE" }];
const green = [{ __typename: "CheckRun", name: "Validate", status: "COMPLETED", conclusion: "SUCCESS" }];

function run(prs, { env = {}, update = {} } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "update-stale-prs-"));
  fs.writeFileSync(path.join(dir, "gh"), STUB, { mode: 0o755 });
  const fixtureFile = path.join(dir, "fixture.json");
  const behind = {};
  for (const p of prs) behind[p.headRefOid] = p.__behind;
  fs.writeFileSync(
    fixtureFile,
    JSON.stringify({ prs: prs.map(({ __behind, ...rest }) => rest), behind, update }),
  );
  const callLog = path.join(dir, "calls.log");
  const r = spawnSync("bash", [SCRIPT], {
    encoding: "utf8",
    env: {
      PATH: `${dir}:${process.env.PATH}`,
      REPO,
      BASE: "main",
      GH_TOKEN: "x",
      FIXTURE: fixtureFile,
      CALL_LOG: callLog,
      ...env,
    },
  });
  const calls = fs.existsSync(callLog) ? fs.readFileSync(callLog, "utf8").split("\n").filter(Boolean) : [];
  return { code: r.status, out: r.stdout + r.stderr, calls, puts: calls.filter((c) => c.startsWith("PUT ")).map((c) => c.slice(4)) };
}

test("without MAX_UPDATES every auto-merge PR that is behind is updated, as before", () => {
  const r = run([pr(1), pr(2, { checks: red }), pr(3), pr(4, { auto: false }), pr(5, { draft: true }), pr(6, { fork: true })]);
  assert.strictEqual(r.code, 0, r.out);
  assert.deepStrictEqual(r.puts.sort(), ["1", "2", "3"], "a red PR is still updated when there is no cap");
});

test("MAX_UPDATES updates only the oldest auto-merge PRs, whatever their numbers", () => {
  const r = run(
    [pr(10, { enabled: "2026-10-12T09:03:00Z" }), pr(11, { enabled: "2026-10-12T09:01:00Z" }), pr(12, { enabled: "2026-10-12T09:02:00Z" })],
    { env: { MAX_UPDATES: "2" } },
  );
  assert.strictEqual(r.code, 0, r.out);
  assert.deepStrictEqual(r.puts, ["11", "12"], "the PRs whose auto-merge was enabled first, in that order");
  assert.match(r.out, /PR #10: left for a later run/);
});

test("a PR with a failed check is passed over and does not use a slot", () => {
  const r = run(
    [pr(1, { enabled: "2026-10-12T09:01:00Z", checks: red }), pr(2, { enabled: "2026-10-12T09:02:00Z", checks: green }), pr(3, { enabled: "2026-10-12T09:03:00Z" })],
    { env: { MAX_UPDATES: "1" } },
  );
  assert.strictEqual(r.code, 0, r.out);
  assert.deepStrictEqual(r.puts, ["2"]);
  assert.match(r.out, /PR #1: passed over, a check on its head has failed/);
});

test("a cancelled, skipped or unreadable rollup is not a failure", () => {
  const cancelled = [{ __typename: "CheckRun", conclusion: "CANCELLED" }, { __typename: "CheckRun", conclusion: "SKIPPED" }];
  const r = run(
    [pr(1, { enabled: "2026-10-12T09:01:00Z", checks: cancelled }), pr(2, { enabled: "2026-10-12T09:02:00Z" })],
    { env: { MAX_UPDATES: "1" } },
  );
  assert.deepStrictEqual(r.puts, ["1"]);
  const unreadable = run([{ ...pr(1, { enabled: "2026-10-12T09:01:00Z" }), statusCheckRollup: null }], { env: { MAX_UPDATES: "1" } });
  assert.deepStrictEqual(unreadable.puts, ["1"], "unknown state is not a failure");
});

test("a status context in the error state counts as failed", () => {
  const ctx = [{ __typename: "StatusContext", context: "ci/legacy", state: "ERROR" }];
  const r = run([pr(1, { enabled: "2026-10-12T09:01:00Z", checks: ctx }), pr(2, { enabled: "2026-10-12T09:02:00Z" })], { env: { MAX_UPDATES: "1" } });
  assert.deepStrictEqual(r.puts, ["2"]);
});

test("a PR that is already current is in flight and uses a slot", () => {
  const r = run(
    [pr(1, { enabled: "2026-10-12T09:01:00Z", behind: 0 }), pr(2, { enabled: "2026-10-12T09:02:00Z" })],
    { env: { MAX_UPDATES: "1" } },
  );
  assert.strictEqual(r.code, 0, r.out);
  assert.deepStrictEqual(r.puts, [], "the current PR holds the only slot, so nothing behind it is touched");
});

test("a PR that conflicts is flagged for its author and does not use a slot", () => {
  const r = run(
    [pr(1, { enabled: "2026-10-12T09:01:00Z" }), pr(2, { enabled: "2026-10-12T09:02:00Z" })],
    { env: { MAX_UPDATES: "1" }, update: { 1: "conflict" } },
  );
  assert.strictEqual(r.code, 0, r.out);
  assert.deepStrictEqual(r.puts, ["1", "2"]);
  assert.ok(r.calls.includes("EDIT 1") && r.calls.includes("COMMENT 1"), "the conflicting PR is labelled and commented");
});

test("a PR that moved during the run uses a slot", () => {
  const r = run(
    [pr(1, { enabled: "2026-10-12T09:01:00Z" }), pr(2, { enabled: "2026-10-12T09:02:00Z" })],
    { env: { MAX_UPDATES: "1" }, update: { 1: "moved" } },
  );
  assert.strictEqual(r.code, 0, r.out);
  assert.deepStrictEqual(r.puts, ["1"]);
});

test("a failed update still fails the run and does not use a slot", () => {
  const r = run(
    [pr(1, { enabled: "2026-10-12T09:01:00Z" }), pr(2, { enabled: "2026-10-12T09:02:00Z" })],
    { env: { MAX_UPDATES: "1" }, update: { 1: "error" } },
  );
  assert.strictEqual(r.code, 1, "an unrecognised failure is unknown state");
  assert.deepStrictEqual(r.puts, ["1", "2"]);
});

test("MAX_UPDATES must be a positive integer, and nothing is called otherwise", () => {
  for (const bad of ["0", "-1", "1.5", "two", "1 2", " "]) {
    const r = run([pr(1)], { env: { MAX_UPDATES: bad } });
    assert.strictEqual(r.code, 1, `'${bad}' must be refused: ${r.out}`);
    assert.match(r.out, /MAX_UPDATES must be a positive integer/);
    assert.deepStrictEqual(r.calls, []);
  }
});

test("an empty MAX_UPDATES is the same as unset", () => {
  const r = run([pr(1), pr(2)], { env: { MAX_UPDATES: "" } });
  assert.strictEqual(r.code, 0, r.out);
  assert.deepStrictEqual(r.puts.sort(), ["1", "2"]);
});
