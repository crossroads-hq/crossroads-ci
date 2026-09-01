const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const CHECK = path.join(__dirname, "check.js");
const CODEX_LOGIN = "chatgpt-codex-connector[bot]";
const CODEX_USER_ID = 199175422;
const HEAD_SHA = "0123456789abcdef0123456789abcdef01234567";

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

function cleanReviewComment(overrides = {}) {
  return {
    id: 23,
    user: { id: CODEX_USER_ID, login: CODEX_LOGIN, type: "Bot" },
    body: "Codex Review: Didn't find any major issues. :tada:\n\n**Reviewed commit:** `0123456789`",
    created_at: "2026-09-01T00:00:00Z",
    updated_at: "2026-09-01T00:00:00Z",
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
  comments = [[[]]],
  failReviews = false,
  failComments = false,
  malformedComments = false,
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
const reviews = JSON.parse(process.env.FAKE_GH_REVIEWS);
const comments = JSON.parse(process.env.FAKE_GH_COMMENTS);
const state = process.env.FAKE_GH_STATE;
const endpoint = process.argv[3] || "";
let kind;
let responses;
if (/\\/pulls\\/\\d+\\/reviews$/.test(endpoint)) {
  kind = "reviews";
  responses = reviews;
} else if (/\\/issues\\/\\d+\\/comments$/.test(endpoint)) {
  kind = "comments";
  responses = comments;
} else {
  console.error(\`unexpected endpoint: \${endpoint}\`);
  process.exit(2);
}
const counts = fs.existsSync(state)
  ? JSON.parse(fs.readFileSync(state, "utf8"))
  : { reviews: 0, comments: 0 };
const count = counts[kind];
counts[kind] += 1;
fs.writeFileSync(state, JSON.stringify(counts));
if (process.env.FAKE_GH_FAIL_KIND === kind) {
  console.error("simulated GitHub API failure");
  process.exit(1);
}
if (process.env.FAKE_GH_MALFORMED_KIND === kind) {
  process.stdout.write("{");
  process.exit(0);
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
      FAKE_GH_REVIEWS: JSON.stringify(reviews),
      FAKE_GH_COMMENTS: JSON.stringify(comments),
      FAKE_GH_STATE: state,
      FAKE_GH_FAIL_KIND: failReviews ? "reviews" : failComments ? "comments" : "",
      FAKE_GH_MALFORMED_KIND: malformedComments ? "comments" : "",
    },
  });

  const result = {
    code: proc.status,
    stdout: proc.stdout,
    stderr: proc.stderr,
    output: parseOutput(output),
    summary: fs.existsSync(summary) ? fs.readFileSync(summary, "utf8") : "",
    calls: fs.existsSync(state)
      ? JSON.parse(fs.readFileSync(state, "utf8"))
      : { reviews: 0, comments: 0 },
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

test("accepts the official Codex clean-review comment for the current head", () => {
  const result = run({ comments: [[[cleanReviewComment()]]] });

  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(result.output, {
    reviewed: "true",
    reason: "codex-clean-comment-found",
    "review-id": "",
  });
});

test("accepts an official clean verdict with a varying same-line suffix", () => {
  const result = run({
    comments: [[[
      cleanReviewComment({
        body: "Codex Review: Didn't find any major issues. Nice work!\n\n**Reviewed commit:** `0123456789`",
      }),
    ]]],
  });

  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.output.reviewed, "true");
  assert.equal(result.output.reason, "codex-clean-comment-found");
});

test("does not accept a Codex clean-review comment for an older head", () => {
  const result = run({
    comments: [[[
      cleanReviewComment({
        body: "Codex Review: Didn't find any major issues. :tada:\n\n**Reviewed commit:** `aaaaaaaaaa`",
      }),
    ]]],
  });

  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.output.reviewed, "false");
});

test("does not accept a spoofed clean-review comment", () => {
  const result = run({
    comments: [[[
      cleanReviewComment({
        user: { id: 999, login: CODEX_LOGIN, type: "Bot" },
      }),
    ]]],
  });

  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.output.reviewed, "false");
});

test("does not accept a clean-review comment with a spoofed login", () => {
  const result = run({
    comments: [[[
      cleanReviewComment({
        user: { id: CODEX_USER_ID, login: "codex-lookalike[bot]", type: "Bot" },
      }),
    ]]],
  });

  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.output.reviewed, "false");
});

test("does not accept a clean-review comment from a non-bot account", () => {
  const result = run({
    comments: [[[
      cleanReviewComment({
        user: { id: CODEX_USER_ID, login: CODEX_LOGIN, type: "User" },
      }),
    ]]],
  });

  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.output.reviewed, "false");
});

test("does not accept an official current-head comment that only quotes the clean verdict", () => {
  const result = run({
    comments: [[[
      cleanReviewComment({
        body: "Found an issue because the workflow treats the text Codex Review: Didn't find any major issues. as a clean verdict.\n\n**Reviewed commit:** `0123456789`",
      }),
    ]]],
  });

  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.output.reviewed, "false");
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

test("does not query pull request reactions because they are not bound to a head SHA", () => {
  const result = run();

  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.calls.reviews, 1);
  assert.equal(result.calls.comments, 1);
  assert.equal(result.output.reviewed, "false");
  assert.equal(result.output.reason, "codex-review-timeout");
});

test("falls back with an explicit unknown-status reason when GitHub cannot be queried", () => {
  const result = run({ failReviews: true });

  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(result.output, {
    reviewed: "false",
    reason: "codex-status-error",
    "review-id": "",
  });
  assert.match(result.summary, /could not verify whether Codex reviewed/i);
});

test("fails closed when clean-review comments cannot be queried", () => {
  const result = run({ failComments: true });

  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(result.output, {
    reviewed: "false",
    reason: "codex-status-error",
    "review-id": "",
  });
  assert.match(result.summary, /could not verify whether Codex posted a clean review/i);
});

test("fails closed when clean-review comments are malformed JSON", () => {
  const result = run({ malformedComments: true });

  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.output.reviewed, "false");
  assert.equal(result.output.reason, "codex-status-error");
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
