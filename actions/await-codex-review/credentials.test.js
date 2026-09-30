const test = require("node:test");
const assert = require("node:assert");
const childProcess = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

// How the Claude fallback authenticates. Kept apart from workflow.test.js so
// credential changes and workflow-step changes do not collide.
const workflow = fs.readFileSync(
  path.join(__dirname, "..", "..", ".github", "workflows", "_ai-review.yml"),
  "utf8"
);

function runScriptForStep(name) {
  const lines = block(name).split("\n");
  const start = lines.indexOf("        run: |");
  assert.notStrictEqual(start, -1, `workflow step '${name}' has no run block`);
  const body = [];
  for (const line of lines.slice(start + 1)) {
    if (line !== "" && !line.startsWith("          ")) break;
    body.push(line.startsWith("          ") ? line.slice(10) : line);
  }
  return body.join("\n");
}

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
