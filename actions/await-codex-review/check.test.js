const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const CHECK = path.join(__dirname, "check.js");
const CODEX_LOGIN = "chatgpt-codex-connector[bot]";
const CODEX_USER_ID = 199175422;
const HEAD_SHA = "head-123";
const WORKFLOW_PATH = ".github/workflows/ci.yml";

function review(overrides = {}) {
  return {
    id: 17,
    user: { id: CODEX_USER_ID, login: CODEX_LOGIN, type: "Bot" },
    commit_id: HEAD_SHA,
    state: "COMMENTED",
    submitted_at: "2026-09-01T00:00:00Z",
    ...overrides,
  };
}

function reaction(overrides = {}) {
  return {
    id: 23,
    user: { id: CODEX_USER_ID, login: CODEX_LOGIN, type: "User" },
    content: "+1",
    created_at: "2026-09-01T00:02:00Z",
    ...overrides,
  };
}

function currentRun(overrides = {}) {
  return {
    id: 9001,
    event: "pull_request",
    path: WORKFLOW_PATH,
    head_sha: HEAD_SHA,
    run_started_at: "2026-09-01T00:00:00Z",
    pull_requests: [{ number: 42 }],
    ...overrides,
  };
}

function workflowRuns(overrides = {}) {
  return [
    {
      workflow_runs: [currentRun(overrides)],
    },
  ];
}

function parseOutput(file) {
  if (!fs.existsSync(file)) return {};
  return Object.fromEntries(
    fs
      .readFileSync(file, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const separator = line.indexOf("=");
        return [line.slice(0, separator), line.slice(separator + 1)];
      })
  );
}

function run({
  reviews = [[[]]],
  reactions = [[[]]],
  runResponse = currentRun(),
  runsResponse = workflowRuns(),
  failGh = false,
  failKinds = [],
  wait = "0",
  poll = "30",
} = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "await-codex-review-"));
  const bin = path.join(root, "bin");
  const output = path.join(root, "output");
  const summary = path.join(root, "summary");
  const state = path.join(root, "gh-state");
  fs.mkdirSync(bin);

  const fakeGh = `#!/usr/bin/env node
const fs = require("node:fs");
const responses = JSON.parse(process.env.FAKE_GH_RESPONSES);
const state = process.env.FAKE_GH_STATE;
const endpoint = process.argv[3] || "";
let kind;
if (/\\/actions\\/runs\\/\\d+$/.test(endpoint)) kind = "run";
else if (/\\/actions\\/runs\\?/.test(endpoint)) kind = "runs";
else if (/\\/pulls\\/\\d+\\/reviews$/.test(endpoint)) kind = "reviews";
else if (/\\/issues\\/\\d+\\/reactions$/.test(endpoint)) kind = "reactions";
else {
  console.error(\`unexpected endpoint: \${endpoint}\`);
  process.exit(2);
}
const counts = fs.existsSync(state) ? JSON.parse(fs.readFileSync(state, "utf8")) : {};
const count = counts[kind] || 0;
counts[kind] = count + 1;
fs.writeFileSync(state, JSON.stringify(counts));
const failKinds = JSON.parse(process.env.FAKE_GH_FAIL_KINDS);
if (process.env.FAKE_GH_FAIL === "true" || failKinds.includes(kind)) {
  console.error("simulated GitHub API failure");
  process.exit(1);
}
const choices = responses[kind];
const response = Array.isArray(choices) ? choices[Math.min(count, choices.length - 1)] : choices;
process.stdout.write(JSON.stringify(response));
`;
  fs.writeFileSync(path.join(bin, "gh"), fakeGh, { mode: 0o755 });
  fs.writeFileSync(path.join(bin, "sleep"), "#!/usr/bin/env node\n", { mode: 0o755 });

  const proc = spawnSync(process.execPath, [CHECK], {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${bin}${path.delimiter}${process.env.PATH}`,
      GH_TOKEN: "test-token",
      REPO: "tsviser/example",
      PR: "42",
      HEAD_SHA,
      WAIT_SECONDS: wait,
      POLL_SECONDS: poll,
      GITHUB_RUN_ID: "9001",
      GITHUB_OUTPUT: output,
      GITHUB_STEP_SUMMARY: summary,
      FAKE_GH_RESPONSES: JSON.stringify({
        reviews,
        reactions,
        run: [runResponse],
        runs: [runsResponse],
      }),
      FAKE_GH_STATE: state,
      FAKE_GH_FAIL: String(failGh),
      FAKE_GH_FAIL_KINDS: JSON.stringify(failKinds),
    },
  });

  const result = {
    code: proc.status,
    stdout: proc.stdout,
    stderr: proc.stderr,
    output: parseOutput(output),
    summary: fs.existsSync(summary) ? fs.readFileSync(summary, "utf8") : "",
    calls: fs.existsSync(state) ? JSON.parse(fs.readFileSync(state, "utf8")) : {},
  };
  fs.rmSync(root, { recursive: true, force: true });
  return result;
}

test("accepts a submitted Codex review for the current head", () => {
  const result = run({ reviews: [[[review()]]] });

  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(result.output, {
    reviewed: "true",
    reason: "codex-review-found",
    "review-id": "17",
  });
});

test("waits and checks again before falling back", () => {
  const result = run({
    reviews: [[[]], [[review()]]],
    wait: "30",
    poll: "30",
  });

  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.calls.reviews, 2);
  assert.equal(result.output.reviewed, "true");
});

test("does not accept a Codex review for an older head", () => {
  const result = run({
    reviews: [[[review({ commit_id: "old-head" })]]],
  });

  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(result.output, {
    reviewed: "false",
    reason: "codex-review-timeout",
    "review-id": "",
  });
});

test("does not accept a spoofed reviewer login", () => {
  const result = run({
    reviews: [[[review({ user: { login: "codex-lookalike[bot]", type: "Bot" } })]]],
  });

  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.output.reviewed, "false");
});

test("does not accept a review with the official login but a different user id", () => {
  const result = run({
    reviews: [
      [[review({ user: { id: 999, login: CODEX_LOGIN, type: "Bot" } })]],
    ],
  });

  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.output.reviewed, "false");
});

test("does not accept pending or dismissed reviews", () => {
  const result = run({
    reviews: [
      [
        [
          review({ id: 18, state: "PENDING", submitted_at: null }),
          review({ id: 19, state: "DISMISSED" }),
        ],
      ],
    ],
  });

  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.output.reviewed, "false");
});

test("does not accept missing, null, or unknown review states", () => {
  const result = run({
    reviews: [
      [
        [
          review({ id: 20, state: undefined }),
          review({ id: 21, state: null }),
          review({ id: 22, state: "FUTURE_STATE" }),
        ],
      ],
    ],
  });

  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.output.reviewed, "false");
});

test("accepts every known submitted review state", () => {
  for (const state of ["COMMENTED", "APPROVED", "CHANGES_REQUESTED"]) {
    const result = run({ reviews: [[[review({ state })]]] });

    assert.equal(result.code, 0, `${state}: ${result.stderr}`);
    assert.equal(result.output.reviewed, "true", state);
  }
});

test("accepts a fresh thumbs-up from the official Codex account", () => {
  const result = run({ reactions: [[[reaction()]]] });

  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(result.output, {
    reviewed: "true",
    reason: "codex-reaction-found",
    "review-id": "",
  });
  assert.match(result.summary, /verified Codex clean reaction #23/i);
});

test("revalidates a same-head reaction on a later workflow run", () => {
  const result = run({
    runResponse: currentRun({ id: 9002, run_started_at: "2026-09-01T00:05:00Z" }),
    runsResponse: [
      {
        workflow_runs: [
          currentRun(),
          currentRun({ id: 9002, run_started_at: "2026-09-01T00:05:00Z" }),
        ],
      },
    ],
    reactions: [[[reaction()]]],
  });

  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.output.reviewed, "true");
  assert.equal(result.output.reason, "codex-reaction-found");
});

test("does not accept a Codex reaction left before this head began running", () => {
  const result = run({
    reactions: [[[reaction({ created_at: "2026-08-31T23:59:59Z" })]]],
  });

  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.output.reviewed, "false");
});

test("does not widen the reaction window with a same-SHA run for another pull request", () => {
  const result = run({
    runResponse: currentRun({ run_started_at: "2026-09-01T00:05:00Z" }),
    runsResponse: [
      {
        workflow_runs: [
          currentRun({
            id: 8999,
            run_started_at: "2026-09-01T00:00:00Z",
            pull_requests: [{ number: 99 }],
          }),
        ],
      },
    ],
    reactions: [[[reaction()]]],
  });

  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.output.reviewed, "false");
});

test("does not widen the reaction window with a queued run that never started", () => {
  const result = run({
    runResponse: currentRun({ run_started_at: "2026-09-01T00:05:00Z" }),
    runsResponse: [
      {
        workflow_runs: [
          currentRun({
            id: 8998,
            run_started_at: null,
            created_at: "2026-09-01T00:00:00Z",
          }),
        ],
      },
    ],
    reactions: [[[reaction()]]],
  });

  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.output.reviewed, "false");
});

test("does not accept a reaction from a lookalike account", () => {
  const result = run({
    reactions: [
      [
        [
          reaction({ user: { id: 999, login: "chatgpt-codex-connector-lookalike[bot]", type: "Bot" } }),
        ],
      ],
    ],
  });

  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.output.reviewed, "false");
});

test("does not accept a non-positive Codex reaction", () => {
  const result = run({ reactions: [[[reaction({ content: "eyes" })]]] });

  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.output.reviewed, "false");
});

test("falls back when the reaction cannot be bound to this workflow and head", () => {
  const result = run({
    runResponse: currentRun({ head_sha: "other-head" }),
    reactions: [[[reaction()]]],
  });

  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.output.reviewed, "false");
  assert.equal(result.output.reason, "codex-status-error");
});

test("a verified reaction still wins when the formal review endpoint is unavailable", () => {
  const result = run({
    reactions: [[[reaction()]]],
    failKinds: ["reviews"],
  });

  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.output.reviewed, "true");
  assert.equal(result.output.reason, "codex-reaction-found");
});

test("a submitted current-head review still wins when run metadata is unavailable", () => {
  const result = run({
    reviews: [[[review()]]],
    failKinds: ["run", "runs"],
  });

  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.output.reviewed, "true");
  assert.equal(result.output.reason, "codex-review-found");
});

test("falls back with an explicit unknown-status reason when GitHub cannot be queried", () => {
  const result = run({ failGh: true });

  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(result.output, {
    reviewed: "false",
    reason: "codex-status-error",
    "review-id": "",
  });
  assert.match(result.summary, /could not verify whether Codex reviewed/i);
});

test("rejects invalid wait configuration instead of looping unpredictably", () => {
  const result = run({ wait: "ten" });

  assert.equal(result.code, 1);
  assert.match(result.stderr, /WAIT_SECONDS must be a non-negative integer/);
});

test("caps the wait so the Claude fallback retains its runtime budget", () => {
  const result = run({ wait: "601" });

  assert.equal(result.code, 1);
  assert.match(result.stderr, /WAIT_SECONDS must not exceed 600/);
});
