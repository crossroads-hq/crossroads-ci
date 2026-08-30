// Tests for the fleet's merge gate. This logic decides whether every
// Crossroads pull request may merge; until now nothing in CI executed it, or
// even parsed it -- the "Composite actions parse" job reads action.yml and
// stops there. Run with:
//
//   node --test actions/gate/check.test.js
//
// CommonJS and node:test only: the gate's whole premise is that it needs
// nothing but the node binary every runner already carries.
const test = require("node:test");
const assert = require("node:assert");
const { spawnSync } = require("node:child_process");
const path = require("node:path");

const CHECK = path.join(__dirname, "check.js");

// `env` replaces the whole environment rather than extending process.env, so a
// stray RESULTS in the ambient shell cannot make a test pass.
function run(results, allowSkipped) {
  const env = {};
  if (results !== undefined) env.RESULTS = results;
  if (allowSkipped !== undefined) env.ALLOW_SKIPPED = allowSkipped;
  const proc = spawnSync(process.execPath, [CHECK], { env, encoding: "utf8" });
  return { code: proc.status, stdout: proc.stdout, stderr: proc.stderr };
}

const json = (obj) => JSON.stringify(obj);

test("passes when every job succeeded", () => {
  assert.equal(run(json({ Verify: "success", "Supply chain": "success" })).code, 0);
});

test("fails on any failure", () => {
  const { code, stderr } = run(json({ Verify: "failure", "Supply chain": "success" }));
  assert.equal(code, 1);
  assert.match(stderr, /Verify did not pass \(failure\)/);
});

test("fails on a skip that is not excused", () => {
  assert.equal(run(json({ Verify: "skipped" })).code, 1);
});

test("passes a skip that is excused", () => {
  assert.equal(run(json({ Verify: "skipped" }), "Verify").code, 0);
});

test("excuses skips by multi-word name, one per line", () => {
  const results = json({ "Workflow lint": "skipped", "Supply chain": "skipped" });
  assert.equal(run(results, "Workflow lint\nSupply chain").code, 0);
});

test("tolerates CRLF and surrounding whitespace in allow-skipped", () => {
  assert.equal(run(json({ "Workflow lint": "skipped" }), "  Workflow lint  \r\n\r\n").code, 0);
});

test("never excuses a cancelled job, even when its name is allow-skipped", () => {
  // A cancelled job in a run that itself stayed live did not finish. The
  // caller's `if: not cancelled()` handles a superseded run; this does not.
  const { code, stderr } = run(json({ Verify: "cancelled" }), "Verify");
  assert.equal(code, 1);
  assert.match(stderr, /cancelled while this run stayed live/);
});

test("fails on an empty result value, as from a needs entry that does not exist", () => {
  // `${{ needs.typo.result }}` interpolates to "", which is valid JSON and
  // must not be mistaken for a pass.
  assert.equal(run(json({ Verify: "" })).code, 1);
});

test("fails on an empty results map rather than vacuously passing", () => {
  const { code, stderr } = run(json({}));
  assert.equal(code, 1);
  assert.match(stderr, /asked to check nothing about/);
});

test("fails on malformed JSON", () => {
  assert.equal(run('{"Verify": }').code, 1);
});

test("fails when RESULTS is unset", () => {
  assert.equal(run(undefined).code, 1);
});

for (const shape of ["[]", '"success"', "null", "42"]) {
  test(`fails when results is ${shape}, not an object`, () => {
    const { code, stderr } = run(shape);
    assert.equal(code, 1);
    assert.match(stderr, /must be a JSON object|not valid JSON/);
  });
}

test("regression: a failed filter job cannot green-light a run of excused skips", () => {
  // The ci.yml hole. When "Detect changes" fails, GitHub marks every job that
  // needs it `skipped`; with all of those excused and the filter job itself
  // absent from `results`, the gate passed having validated nothing.
  const excused = "Workflow lint\nScripts";

  const holeShape = json({
    "Workflow lint": "skipped",
    Scripts: "skipped",
    "Supply chain": "skipped",
  });
  assert.equal(run(holeShape, excused).code, 1, "an unexcused skip must fail");

  const fixedShape = json({
    "Detect changes": "failure",
    "Workflow lint": "skipped",
    Scripts: "skipped",
    "Supply chain": "success",
  });
  assert.equal(run(fixedShape, excused).code, 1, "a failed filter job must fail the gate");
});

test("the docs-only path still passes: filter succeeded, filtered legs skipped", () => {
  const results = json({
    "Detect changes": "success",
    "Workflow lint": "skipped",
    Scripts: "skipped",
    "Supply chain": "success",
  });
  assert.equal(run(results, "Workflow lint\nScripts").code, 0);
});
