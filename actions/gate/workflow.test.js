const test = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const workflow = path.join(__dirname, "../../.github/workflows/ci.yml");
const gate = JSON.parse(execFileSync("ruby", [
  "-ryaml", "-rjson", "-e",
  'puts JSON.generate(YAML.safe_load(File.read(ARGV.fetch(0))).fetch("jobs").fetch("gate"))',
  workflow,
], { encoding: "utf8" }));
const selector = gate.steps.find((step) => step.id === "allowed-skips");
const check = gate.steps.find((step) => step.uses === "./actions/gate");

test("the gate takes skip allowances from the change filter outputs", () => {
  assert.deepEqual(selector.env, {
    WORKFLOW_CHANGED: "${{ needs.changes.outputs.workflow }}",
    SCRIPTS_CHANGED: "${{ needs.changes.outputs.scripts }}",
  });
  assert.equal(check.with["allow-skipped"], "${{ steps.allowed-skips.outputs.jobs }}");
  assert.ok(gate.needs.includes("changes"));
  assert.match(check.with.results, /"Detect changes": "\$\{\{ needs\.changes\.result \}\}"/);
});

const cases = [
  ["a docs-only PR", "pull_request", "false", "false", ["Workflow lint", "Scripts"]],
  ["a workflow change", "pull_request", "true", "false", ["Scripts"]],
  ["a script change", "pull_request", "false", "true", ["Workflow lint"]],
  ["missing output", "pull_request", "", "", []],
  ["malformed output", "pull_request", "FALSE", "false ", []],
  ["a push", "push", "false", "false", []],
  ["a merge-queue run", "merge_group", "false", "false", []],
];

for (const [label, event, workflowChanged, scriptsChanged, expected] of cases) {
  test(`the gate checks skip permissions for ${label}`, (t) => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ci-skips-"));
    t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
    const output = path.join(tempDir, "output");
    execFileSync("bash", ["--noprofile", "--norc", "-eo", "pipefail", "-c", selector.run], {
      env: {
        GITHUB_OUTPUT: output,
        GITHUB_EVENT_NAME: event,
        WORKFLOW_CHANGED: workflowChanged,
        SCRIPTS_CHANGED: scriptsChanged,
      },
    });
    const lines = fs.readFileSync(output, "utf8").split("\n");
    assert.deepEqual(lines, ["jobs<<EOF", ...expected, "EOF", ""]);
    const allowSkipped = lines.slice(1, -2).join("\n");
    const results = {
      "Detect changes": "success",
      "Workflow lint": "success",
      Scripts: "success",
      "Supply chain": "success",
    };
    for (const job of ["Workflow lint", "Scripts"]) {
      const result = spawnSync(process.execPath, [path.join(__dirname, "check.js")], {
        env: {
          ALLOW_SKIPPED: allowSkipped,
          RESULTS: JSON.stringify({ ...results, [job]: "skipped" }),
        },
        encoding: "utf8",
      });
      assert.equal(result.status, expected.includes(job) ? 0 : 1, result.stderr);
    }
  });
}
