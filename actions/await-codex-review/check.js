const fs = require("node:fs");
const { spawnSync } = require("node:child_process");

const CODEX_LOGIN = "chatgpt-codex-connector[bot]";
const CODEX_USER_ID = 199175422;
const SUBMITTED_STATES = new Set(["COMMENTED", "APPROVED", "CHANGES_REQUESTED"]);

function fail(message) {
  console.error(message);
  process.exit(1);
}

function integer(name, { allowZero }) {
  const value = process.env[name];
  const pattern = allowZero ? /^\d+$/ : /^[1-9]\d*$/;
  if (!pattern.test(value || "")) {
    fail(`${name} must be a ${allowZero ? "non-negative" : "positive"} integer.`);
  }
  return Number(value);
}

function append(file, text) {
  fs.appendFileSync(file, `${text}\n`);
}

function finish(reviewed, reason, reviewId, summary) {
  append(process.env.GITHUB_OUTPUT, `reviewed=${reviewed}`);
  append(process.env.GITHUB_OUTPUT, `reason=${reason}`);
  append(process.env.GITHUB_OUTPUT, `review-id=${reviewId || ""}`);
  append(process.env.GITHUB_STEP_SUMMARY, summary);
}

function request(endpoint, { paginate = false } = {}) {
  const args = ["api", endpoint];
  if (paginate) args.push("--paginate", "--slurp");
  const proc = spawnSync("gh", args, {
    encoding: "utf8",
    env: process.env,
  });

  if (proc.status !== 0) {
    return { error: proc.stderr.trim() || `gh exited ${proc.status}` };
  }

  try {
    return { data: JSON.parse(proc.stdout) };
  } catch (error) {
    return { error: `GitHub response was not valid JSON: ${error.message}` };
  }
}

function pageItems(result, key) {
  if (result.error) return result;
  if (!Array.isArray(result.data) || result.data.some((page) => !Array.isArray(page))) {
    return { error: `GitHub ${key} response was not an array of pages.` };
  }
  return { [key]: result.data.flat() };
}

function fetchReviews() {
  return pageItems(
    request(`repos/${process.env.REPO}/pulls/${process.env.PR}/reviews`, { paginate: true }),
    "reviews"
  );
}

function fetchReactions() {
  return pageItems(
    request(`repos/${process.env.REPO}/issues/${process.env.PR}/reactions`, { paginate: true }),
    "reactions"
  );
}

function includesPullRequest(run, prNumber) {
  return (
    Array.isArray(run?.pull_requests) &&
    run.pull_requests.some((pullRequest) => pullRequest?.number === prNumber)
  );
}

function reactionWindow(prNumber) {
  const current = request(`repos/${process.env.REPO}/actions/runs/${process.env.GITHUB_RUN_ID}`);
  if (current.error) return current;

  const run = current.data;
  if (
    !run ||
    run.event !== "pull_request" ||
    run.head_sha !== process.env.HEAD_SHA ||
    !includesPullRequest(run, prNumber) ||
    typeof run.path !== "string" ||
    !run.path
  ) {
    return { error: "Current Actions run does not match this pull request head and workflow." };
  }

  const history = request(
    `repos/${process.env.REPO}/actions/runs?head_sha=${process.env.HEAD_SHA}&per_page=100`,
    { paginate: true }
  );
  if (history.error) return history;
  if (
    !Array.isArray(history.data) ||
    history.data.some((page) => !page || !Array.isArray(page.workflow_runs))
  ) {
    return { error: "GitHub workflow runs response was not an array of pages." };
  }

  const matchingRuns = [run, ...history.data.flatMap((page) => page.workflow_runs)].filter(
    (candidate) =>
      candidate?.event === "pull_request" &&
      candidate?.head_sha === process.env.HEAD_SHA &&
      includesPullRequest(candidate, prNumber) &&
      candidate?.path === run.path
  );
  const starts = matchingRuns
    .map((candidate) => Date.parse(candidate.run_started_at || ""))
    .filter(Number.isFinite);
  if (starts.length === 0) {
    return { error: "No trusted workflow start time was available for this pull request head." };
  }

  return { startedAt: Math.min(...starts) };
}

for (const name of [
  "REPO",
  "PR",
  "HEAD_SHA",
  "GITHUB_RUN_ID",
  "GITHUB_OUTPUT",
  "GITHUB_STEP_SUMMARY",
]) {
  if (!process.env[name]) fail(`${name} is required.`);
}

const waitSeconds = integer("WAIT_SECONDS", { allowZero: true });
const pollSeconds = integer("POLL_SECONDS", { allowZero: false });
const prNumber = Number(process.env.PR);
if (!Number.isSafeInteger(prNumber) || prNumber <= 0) fail("PR must be a positive integer.");
if (waitSeconds > 600) fail("WAIT_SECONDS must not exceed 600.");
let remaining = waitSeconds;
const window = reactionWindow(prNumber);

while (true) {
  const reviewResult = fetchReviews();

  const review = reviewResult.reviews?.find(
    (review) =>
      review?.user?.login === CODEX_LOGIN &&
      review?.user?.id === CODEX_USER_ID &&
      review?.user?.type === "Bot" &&
      review?.commit_id === process.env.HEAD_SHA &&
      review?.submitted_at &&
      SUBMITTED_STATES.has(review?.state)
  );

  if (review) {
    finish(
      true,
      "codex-review-found",
      String(review.id),
      `Verified Codex review #${review.id} for head ${process.env.HEAD_SHA}; Claude fallback is not needed.`
    );
    break;
  }

  const reactionResult = window.error ? { error: window.error } : fetchReactions();
  const reaction = reactionResult.reactions?.find((candidate) => {
    const createdAt = Date.parse(candidate?.created_at || "");
    return (
      candidate?.user?.id === CODEX_USER_ID &&
      candidate?.user?.login === CODEX_LOGIN &&
      candidate?.content === "+1" &&
      Number.isFinite(createdAt) &&
      createdAt >= window.startedAt
    );
  });

  if (reaction) {
    finish(
      true,
      "codex-reaction-found",
      "",
      `Verified Codex clean reaction #${reaction.id} for head ${process.env.HEAD_SHA}; Claude fallback is not needed.`
    );
    break;
  }

  const statusError = reviewResult.error || reactionResult.error;
  if (statusError) {
    console.log(`::warning::Could not query Codex verdict state: ${statusError}`);
    finish(
      false,
      "codex-status-error",
      "",
      "Could not verify whether Codex reviewed the current head; falling back to Claude."
    );
    break;
  }

  if (remaining === 0) {
    finish(
      false,
      "codex-review-timeout",
      "",
      `No Codex review or clean reaction was found for head ${process.env.HEAD_SHA} after ${waitSeconds} second(s); falling back to Claude.`
    );
    break;
  }

  const delay = Math.min(pollSeconds, remaining);
  const sleeper = spawnSync("sleep", [String(delay)], { stdio: "inherit" });
  if (sleeper.status !== 0) {
    console.log(`::warning::Could not wait for Codex review state (sleep exited ${sleeper.status}).`);
    finish(
      false,
      "codex-status-error",
      "",
      "Could not complete the wait for a Codex review; falling back to Claude."
    );
    break;
  }
  remaining -= delay;
}
