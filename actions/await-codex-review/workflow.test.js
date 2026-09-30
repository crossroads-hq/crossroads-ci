const test = require("node:test");
const assert = require("node:assert");
const childProcess = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const workflow = fs.readFileSync(
  path.join(__dirname, "..", "..", ".github", "workflows", "_ai-review.yml"),
  "utf8"
);

function runScriptForStep(name) {
  const marker = `      - name: ${name}\n`;
  const stepStart = workflow.indexOf(marker);
  assert.notStrictEqual(stepStart, -1, `workflow step '${name}' is missing`);

  const runMarker = "        run: |\n";
  const runStart = workflow.indexOf(runMarker, stepStart);
  assert.notStrictEqual(runStart, -1, `workflow step '${name}' has no run block`);

  const bodyStart = runStart + runMarker.length;
  const lines = workflow.slice(bodyStart).split("\n");
  const body = [];
  for (const line of lines) {
    if (line !== "" && !line.startsWith("          ")) break;
    body.push(line.startsWith("          ") ? line.slice(10) : line);
  }
  return body.join("\n");
}

test("a prior Codex-only success is revalidated instead of deduplicated", () => {
  assert.match(
    workflow,
    /select\(any\(\.steps\[\]\?;\s*\.name == "Confirm a review actually reached the pull request" and\s*\.conclusion == "success"\)\)/s
  );
  assert.doesNotMatch(
    workflow,
    /select\(\(\.name \| endswith\("AI review"\)\) and \.conclusion == "success"\)\]\s*\| length/
  );
});

test("the Claude fallback uses the lower-cost Sonnet model", () => {
  assert.match(
    workflow,
    /claude_args:\s*\|\s*\n\s*--model sonnet\s*\n\s*--max-turns/s
  );
});

test("the workflow pins the detector with clean-comment support", () => {
  assert.match(
    workflow,
    /uses: crossroads-hq\/crossroads-ci\/actions\/await-codex-review@c863c4b2c0e3614b50986277a22b962bc98402ee # await-codex-review v1/
  );
});

test("the Codex delivery wait covers the observed review latency", () => {
  assert.match(
    workflow,
    /codex-wait-seconds:[\s\S]*?default: 300/
  );
});

test("a pre-inference API rejection is reported without exposing the transcript or credentials", (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-api-error-"));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const summary = path.join(tempDir, "summary.md");
  fs.writeFileSync(
    path.join(tempDir, "claude-execution-output.json"),
    JSON.stringify([
      {
        type: "assistant",
        message: { content: [{ type: "text", text: "TRANSCRIPT MUST STAY HIDDEN" }] }
      },
      {
        type: "result",
        subtype: "success",
        is_error: true,
        duration_api_ms: 0,
        num_turns: 1,
        total_cost_usd: 0,
        modelUsage: {},
        result: "API Error: Rate limit reached for sk-ant-api01-secretvalue"
      }
    ])
  );

  childProcess.execFileSync("bash", ["-c", runScriptForStep("Expose sanitized Claude API rejection")], {
    env: {
      ...process.env,
      EXECUTION_FILE: path.join(tempDir, "claude-execution-output.json"),
      GITHUB_STEP_SUMMARY: summary
    }
  });

  const output = fs.readFileSync(summary, "utf8");
  assert.match(output, /API Error: Rate limit reached for \[REDACTED\]/);
  assert.doesNotMatch(output, /TRANSCRIPT MUST STAY HIDDEN/);
  assert.doesNotMatch(output, /sk-ant-api01-secretvalue/);
});

function block(name) {
  const marker = `      - name: ${name}\n`;
  const start = workflow.indexOf(marker);
  assert.notStrictEqual(start, -1, `workflow step '${name}' is missing`);
  const next = workflow.indexOf("\n      - name: ", start + marker.length);
  return workflow.slice(start, next === -1 ? undefined : next);
}

test("the reviewer accepts an Anthropic API key and an OAuth token, neither required alone", () => {
  const secrets = workflow.slice(workflow.indexOf("    secrets:\n"), workflow.indexOf("\npermissions:"));
  assert.match(secrets, /anthropic-api-key:[\s\S]*?required: false/);
  assert.match(secrets, /claude-code-oauth-token:[\s\S]*?required: false/);
});

test("an API key, when present, is the only credential handed to the reviewer", () => {
  // The action exports both to Claude Code; passing both leaves which one
  // authenticates to Claude Code's precedence. Make the key win by construction.
  const step = block("Claude review");
  assert.match(step, /^\s+anthropic_api_key: \$\{\{ secrets\.anthropic-api-key \}\}$/m);
  assert.match(
    step,
    /^\s+claude_code_oauth_token: \$\{\{ !secrets\.anthropic-api-key && secrets\.claude-code-oauth-token \|\| '' \}\}$/m
  );
});

test("a run with neither credential fails by name before the reviewer starts", () => {
  const step = block("Check a reviewer credential is present");
  assert.match(step, /steps\.codex\.outputs\.reviewed != 'true'/);
  for (const [env, expectFail] of [
    [{ ANTHROPIC_API_KEY_SET: "", OAUTH_TOKEN_SET: "" }, true],
    [{ ANTHROPIC_API_KEY_SET: "true", OAUTH_TOKEN_SET: "" }, false],
    [{ ANTHROPIC_API_KEY_SET: "", OAUTH_TOKEN_SET: "true" }, false],
  ]) {
    const proc = childProcess.spawnSync("bash", ["-c", runScriptForStep("Check a reviewer credential is present")], {
      env: { ...process.env, ...env },
      encoding: "utf8",
    });
    assert.equal(proc.status !== 0, expectFail, JSON.stringify(env) + proc.stderr);
    if (expectFail) assert.match(proc.stderr, /anthropic-api-key/);
  }
});

test("crossroads-ci's own caller passes the fleet API key", () => {
  const ci = fs.readFileSync(path.join(__dirname, "..", "..", ".github", "workflows", "ci.yml"), "utf8");
  assert.match(ci, /anthropic-api-key: \$\{\{ secrets\.ANTHROPIC_API_KEY \}\}/);
});
