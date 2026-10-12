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
    /uses: crossroads-hq\/crossroads-ci\/actions\/await-codex-review@36410e8c5f83a0f3b172191852223c0ec7bc3956 # main after #68 and #71/
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

function stepBlock(name) {
  const marker = `      - name: ${name}\n`;
  const start = workflow.indexOf(marker);
  assert.notStrictEqual(start, -1, `workflow step '${name}' is missing`);
  const next = workflow.indexOf("\n      - name: ", start + marker.length);
  return workflow.slice(start, next === -1 ? undefined : next);
}

test("the API rejection step runs after the review fails, not only after it succeeds", () => {
  // An `if:` with no status function is implicitly `success() && ...`, so a
  // step gated only on a failed predecessor can never run (crossroads-ci#66).
  const ifLine = stepBlock("Expose sanitized Claude API rejection").match(/^\s+if: (.*)$/m);
  assert.ok(ifLine, "the step must carry an if:");
  assert.match(ifLine[1], /\bfailure\(\)|\balways\(\)|!cancelled\(\)/);
  assert.match(ifLine[1], /steps\.review\.outcome == 'failure'/);
});

test("inline comments post live instead of through the action's shared /tmp buffer", () => {
  // The action buffers to a fixed /tmp path that outlives the job on
  // persistent runners and is never deleted; without an Anthropic API key it
  // then posts every stale entry to whatever PR runs next (crossroads-ci#66).
  assert.match(
    stepBlock("Claude review"),
    /^\s+classify_inline_comments: 'false'\s*$/m
  );
});

function runRejectionStep(t, result) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-api-error-"));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const summary = path.join(tempDir, "summary.md");
  const terminal = {
    type: "result",
    subtype: "success",
    is_error: true,
    num_turns: 1,
    total_cost_usd: 0,
    modelUsage: {}
  };
  if (result !== undefined) terminal.result = result;
  fs.writeFileSync(
    path.join(tempDir, "claude-execution-output.json"),
    JSON.stringify([
      { type: "assistant", message: { content: [{ type: "text", text: "TRANSCRIPT MUST STAY HIDDEN" }] } },
      terminal
    ])
  );
  childProcess.execFileSync("bash", ["-c", runScriptForStep("Expose sanitized Claude API rejection")], {
    env: {
      ...process.env,
      EXECUTION_FILE: path.join(tempDir, "claude-execution-output.json"),
      GITHUB_STEP_SUMMARY: summary
    }
  });
  return fs.existsSync(summary) ? fs.readFileSync(summary, "utf8") : "";
}

test("a pre-inference rejection is reported whatever its wording, since no model ran", (t) => {
  // crossroads-ci#67's own run: is_error, zero cost, empty modelUsage, and a
  // result that did not start with "API Error:" -- so nothing was printed.
  const output = runRejectionStep(t, "Invalid bearer token sk-ant-oat01-secretvalue");
  assert.match(output, /Invalid bearer token \[REDACTED\]/);
  assert.doesNotMatch(output, /sk-ant-oat01-secretvalue/);
  assert.doesNotMatch(output, /TRANSCRIPT MUST STAY HIDDEN/);
});

test("a pre-inference rejection with no result text says so instead of printing nothing", (t) => {
  assert.match(runRejectionStep(t, undefined), /no result text/i);
  assert.match(runRejectionStep(t, ""), /no result text/i);
});

test("the detector pin is a main commit that reviews guidance-only changes", () => {
  // Pinned to a squash-merge commit ON main. The previous pin, 4ef8a6f, lived
  // only on #71's deleted branch: reachable from no ref, so eligible for
  // garbage collection, which would break every fleet review at once.
  assert.match(
    workflow,
    /uses: crossroads-hq\/crossroads-ci\/actions\/detect-reviewable@36410e8c5f83a0f3b172191852223c0ec7bc3956 # main after #68 and #71/
  );
});

// The PR updater (_update-stale-prs.yml) pushes as this GitHub App, so the
// pull_request runs it starts have `github.actor` == "<slug>[bot]". Checked
// against the API: `gh api apps/crossroads-ci-pr-updater` (owned by
// crossroads-hq) and `gh api users/crossroads-ci-pr-updater%5Bbot%5D` (type
// Bot); no user or organization of the bare name exists.
const PR_UPDATER_SLUG = "crossroads-ci-pr-updater";

// claude-code-action refuses a non-User actor that `allowed_bots` does not
// list (src/github/validation/actor.ts, at the SHA the workflow pins): the
// list is comma-separated, entries are lowercased with a trailing `[bot]`
// removed, and so is the actor. Mirrored here so the test asks the question
// that matters -- would THIS actor be admitted? -- rather than only comparing
// strings. Re-read actor.ts when the action's pin moves.
function actionAdmitsBot(actor, allowedBots) {
  const trimmed = allowedBots.trim();
  if (trimmed === "*") return true;
  if (!trimmed) return false;
  const normalize = (name) => name.trim().toLowerCase().replace(/\[bot\]$/, "");
  return trimmed.split(",").map(normalize).filter(Boolean).includes(normalize(actor));
}

function claudeReviewAllowedBots() {
  const stepStart = workflow.indexOf("uses: anthropics/claude-code-action@");
  assert.notStrictEqual(stepStart, -1, "the claude-code-action step is missing");
  const nextStep = workflow.indexOf("\n      - name:", stepStart);
  const step = workflow.slice(stepStart, nextStep === -1 ? undefined : nextStep);
  // Ten spaces: a `with:` input, not text inside the prompt block below it.
  const inputs = [...step.matchAll(/^ {10}allowed_bots:[ \t]*(.*)$/gm)];
  assert.strictEqual(
    inputs.length,
    1,
    "the Claude review step must set allowed_bots exactly once; without it the action rejects the PR updater's pushes as a non-human actor (crossroads-ci#102)"
  );
  return inputs[0][1].replace(/\s+#.*$/, "").replace(/^(['"])(.*)\1$/, "$2");
}

test("the Claude review admits the PR updater, whose pushes would otherwise leave the head unreviewed", () => {
  // crossroads-ci#102: without this, the action fails with "Workflow initiated
  // by non-human actor: crossroads-ci-pr-updater (type: Bot)", and a re-run
  // keeps the original actor, so only a person's push could recover it.
  const allowedBots = claudeReviewAllowedBots();
  assert.ok(
    actionAdmitsBot(`${PR_UPDATER_SLUG}[bot]`, allowedBots),
    `allowed_bots is ${JSON.stringify(allowedBots)}, which does not admit ${PR_UPDATER_SLUG}[bot]`
  );
});

test("the Claude review admits the PR updater and no other bot", () => {
  // The reviewer holds pull-requests: write, and the action checks a listed
  // bot by name only. '*' would let any GitHub App that can start a run in
  // this repository drive the reviewer.
  const allowedBots = claudeReviewAllowedBots();
  assert.notStrictEqual(allowedBots.trim(), "*", "allowed_bots must not be '*'");
  const entries = allowedBots.split(",").map((entry) => entry.trim().toLowerCase().replace(/\[bot\]$/, ""));
  assert.deepStrictEqual(entries, [PR_UPDATER_SLUG]);
  for (const actor of [
    "dependabot[bot]",
    "github-actions[bot]",
    "claude[bot]",
    "copilot",
    `${PR_UPDATER_SLUG}-fork[bot]`,
    `not-${PR_UPDATER_SLUG}[bot]`
  ]) {
    assert.strictEqual(actionAdmitsBot(actor, allowedBots), false, `${actor} must not be admitted`);
  }
});
