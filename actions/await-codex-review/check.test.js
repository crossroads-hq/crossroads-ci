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
  failGh = false,
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
if (!/\\/pulls\\/\\d+\\/reviews$/.test(endpoint)) {
  console.error(\`unexpected endpoint: \${endpoint}\`);
  process.exit(2);
}
const count = fs.existsSync(state) ? Number(fs.readFileSync(state, "utf8")) : 0;
fs.writeFileSync(state, String(count + 1));
if (process.env.FAKE_GH_FAIL === "true") {
  console.error("simulated GitHub API failure");
  process.exit(1);
}
const response = responses[Math.min(count, responses.length - 1)];
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
      GITHUB_OUTPUT: output,
      GITHUB_STEP_SUMMARY: summary,
      FAKE_GH_RESPONSES: JSON.stringify(reviews),
      FAKE_GH_STATE: state,
      FAKE_GH_FAIL: String(failGh),
    },
  });

  const result = {
    code: proc.status,
    stdout: proc.stdout,
    stderr: proc.stderr,
    output: parseOutput(output),
    summary: fs.existsSync(summary) ? fs.readFileSync(summary, "utf8") : "",
    calls: fs.existsSync(state) ? Number(fs.readFileSync(state, "utf8")) : 0,
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
  assert.equal(result.calls, 2);
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

test("does not query pull request reactions because they are not bound to a head SHA", () => {
  const result = run();

  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.calls, 1);
  assert.equal(result.output.reviewed, "false");
  assert.equal(result.output.reason, "codex-review-timeout");
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
