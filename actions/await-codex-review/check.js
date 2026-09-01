const fs = require("node:fs");
const { spawnSync } = require("node:child_process");

const CODEX_LOGIN = "chatgpt-codex-connector[bot]";
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

function fetchReviews() {
  const endpoint = `repos/${process.env.REPO}/pulls/${process.env.PR}/reviews`;
  const proc = spawnSync("gh", ["api", endpoint, "--paginate", "--slurp"], {
    encoding: "utf8",
    env: process.env,
  });

  if (proc.status !== 0) {
    return { error: proc.stderr.trim() || `gh exited ${proc.status}` };
  }

  try {
    const pages = JSON.parse(proc.stdout);
    if (!Array.isArray(pages) || pages.some((page) => !Array.isArray(page))) {
      return { error: "GitHub reviews response was not an array of pages." };
    }
    return { reviews: pages.flat() };
  } catch (error) {
    return { error: `GitHub reviews response was not valid JSON: ${error.message}` };
  }
}

for (const name of ["REPO", "PR", "HEAD_SHA", "GITHUB_OUTPUT", "GITHUB_STEP_SUMMARY"]) {
  if (!process.env[name]) fail(`${name} is required.`);
}

const waitSeconds = integer("WAIT_SECONDS", { allowZero: true });
const pollSeconds = integer("POLL_SECONDS", { allowZero: false });
if (waitSeconds > 600) fail("WAIT_SECONDS must not exceed 600.");
let remaining = waitSeconds;

while (true) {
  const result = fetchReviews();
  if (result.error) {
    console.log(`::warning::Could not query Codex review state: ${result.error}`);
    finish(
      false,
      "codex-status-error",
      "",
      "Could not verify whether Codex reviewed the current head; falling back to Claude."
    );
    break;
  }

  const match = result.reviews.find(
    (review) =>
      review?.user?.login === CODEX_LOGIN &&
      review?.user?.type === "Bot" &&
      review?.commit_id === process.env.HEAD_SHA &&
      review?.submitted_at &&
      SUBMITTED_STATES.has(review?.state)
  );

  if (match) {
    finish(
      true,
      "codex-review-found",
      String(match.id),
      `Verified Codex review #${match.id} for head ${process.env.HEAD_SHA}; Claude fallback is not needed.`
    );
    break;
  }

  if (remaining === 0) {
    finish(
      false,
      "codex-review-timeout",
      "",
      `No submitted Codex review was found for head ${process.env.HEAD_SHA} after ${waitSeconds} second(s); falling back to Claude.`
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
