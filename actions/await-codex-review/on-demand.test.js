// `codex-first` in _ai-review.yml: the default keeps every existing caller's
// behaviour; `false` is the on-demand (claude-review label) path.
const test = require("node:test");
const assert = require("node:assert/strict");
const childProcess = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");

const workflowText = fs.readFileSync(
  path.join(__dirname, "..", "..", ".github", "workflows", "_ai-review.yml"),
  "utf8"
);
const parsed = childProcess.spawnSync(
  "ruby",
  ["-ryaml", "-rjson", "-e", "puts JSON.generate(YAML.safe_load(STDIN.read))"],
  { input: workflowText.replace(/^on:/m, '"on":'), encoding: "utf8" }
);
assert.equal(parsed.status, 0, parsed.stderr);
const workflow = JSON.parse(parsed.stdout);
const job = workflow.jobs.review;
const step = (name) => job.steps.find((s) => s.name === name);

// Evaluates the small Actions expression subset these conditions use.
function evaluate(expression, { codexFirst, draft = false, outputs = {} }) {
  const scope = {
    inputs: { "codex-first": codexFirst },
    github: {
      event_name: "pull_request",
      actor: "owner",
      repository: "org/repo",
      event: {
        pull_request: {
          number: 7,
          draft,
          title: "Change",
          head: { repo: { full_name: "org/repo" } },
        },
      },
    },
    steps: {
      changes: { outputs: { reviewable: "true" } },
      dedup: { outputs: { skip: "false" } },
      codex: { outputs: {} },
      ...outputs,
    },
    contains: (value, needle) => value.includes(needle),
  };
  const js = expression
    .trim()
    .replace(/^\$\{\{([\s\S]*)\}\}$/, "$1")
    .replace(/\.([a-zA-Z][a-zA-Z0-9]*-[a-zA-Z0-9-]+)/g, (_, key) => `["${key}"]`);
  return vm.runInNewContext(js, scope, { timeout: 100 });
}

test("codex-first defaults to true, so existing callers are unchanged", () => {
  const input = workflow.on.workflow_call.inputs["codex-first"];
  assert.equal(input.type, "boolean");
  assert.equal(input.required, false);
  assert.equal(input.default, true);
});

test("drafts are skipped Codex-first and reviewed on demand", () => {
  assert.equal(evaluate(job.if, { codexFirst: true, draft: false }), true);
  assert.equal(evaluate(job.if, { codexFirst: true, draft: true }), false);
  assert.equal(evaluate(job.if, { codexFirst: false, draft: true }), true);
  assert.equal(evaluate(job.if, { codexFirst: false, draft: false }), true);
});

test("on demand still honours the fork guard", () => {
  const forked = job.if.replace("github.repository", "'other/repo'");
  assert.equal(evaluate(forked, { codexFirst: false, draft: true }), false);
});

test("the Codex wait runs Codex-first and is skipped on demand", () => {
  const wait = step("Wait for Codex review");
  assert.equal(evaluate(wait.if, { codexFirst: true }), true);
  assert.equal(evaluate(wait.if, { codexFirst: false }), false);
  // Skipped leaves `reviewed` unset, which the reviewer treats as not reviewed.
  assert.equal(evaluate(step("Claude review").if, { codexFirst: false }), true);
});

test("the default concurrency group is unchanged; on-demand gets its own", () => {
  const group = job.concurrency.group;
  const render = (codexFirst) =>
    group.replace(/\$\{\{([^}]*)\}\}/g, (_, expr) =>
      String(evaluate(`\${{${expr}}}`, { codexFirst }))
    );
  assert.equal(render(true), "crossroads-ai-review-org/repo-7");
  assert.equal(render(false), "crossroads-ai-review-org/repo-7-on-demand");
  assert.equal(job.concurrency["cancel-in-progress"], true);
});

function runDedup(codexFirst) {
  const marker = "      - name: Check whether Claude already reviewed this head SHA\n";
  const start = workflowText.indexOf(marker);
  const runStart = workflowText.indexOf("        run: |\n", start) + "        run: |\n".length;
  const body = [];
  for (const line of workflowText.slice(runStart).split("\n")) {
    if (line !== "" && !line.startsWith("          ")) break;
    body.push(line.slice(10));
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "on-demand-dedup-"));
  // A gh that fails loudly: on demand must never reach the API.
  fs.writeFileSync(path.join(dir, "gh"), "#!/bin/sh\necho 'gh called' >&2\nexit 99\n", { mode: 0o755 });
  const output = path.join(dir, "output");
  const result = childProcess.spawnSync("bash", ["-c", body.join("\n")], {
    encoding: "utf8",
    env: {
      PATH: `${dir}:${process.env.PATH}`,
      GITHUB_OUTPUT: output,
      GITHUB_STEP_SUMMARY: path.join(dir, "summary"),
      CODEX_FIRST: String(codexFirst),
      HEAD_SHA: "abc123",
      REPO: "org/repo",
      WORKFLOW_REF: "org/repo/.github/workflows/claude-review.yml@refs/pull/7/merge",
    },
  });
  const written = fs.existsSync(output) ? fs.readFileSync(output, "utf8") : "";
  fs.rmSync(dir, { recursive: true, force: true });
  return { result, written };
}

test("on demand skips the head-SHA dedup without calling the API", () => {
  const { result, written } = runDedup(false);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(written, "skip=false\n");
  assert.doesNotMatch(result.stderr, /gh called/);
});

test("Codex-first still runs the head-SHA dedup", () => {
  const { result } = runDedup(true);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /gh called/);
});
