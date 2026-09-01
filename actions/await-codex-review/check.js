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

function fetchComments() {
  const endpoint = `repos/${process.env.REPO}/issues/${process.env.PR}/comments`;
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
      return { error: "GitHub comments response was not an array of pages." };
    }
    return { comments: pages.flat() };
  } catch (error) {
    return { error: `GitHub comments response was not valid JSON: ${error.message}` };
  }
}

function resolveCommit(abbreviatedSha) {
  const endpoint = `repos/${process.env.REPO}/commits/${abbreviatedSha}`;
  const proc = spawnSync("gh", ["api", endpoint], {
    encoding: "utf8",
    env: process.env,
  });

  if (proc.status !== 0) {
    return { error: proc.stderr.trim() || `gh exited ${proc.status}` };
  }

  try {
    const commit = JSON.parse(proc.stdout);
    if (!commit || typeof commit !== "object" || !/^[0-9a-f]{40}$/i.test(commit.sha || "")) {
      return { error: "GitHub commit response did not contain a full SHA." };
    }
    return { sha: commit.sha };
  } catch (error) {
    return { error: `GitHub commit response was not valid JSON: ${error.message}` };
  }
}

function isCodexBot(user) {
  return (
    user?.id === CODEX_USER_ID &&
    user?.login === CODEX_LOGIN &&
    user?.type === "Bot"
  );
}

function reviewedCommit(body) {
  if (typeof body !== "string") return "";
  return body.match(
    /^Codex Review: Didn't find any major issues\.[^\r\n]*\r?\n\r?\n\*\*Reviewed commit:\*\* `([0-9a-f]{7,40})`(?:\r?\n|$)/
  )?.[1] || "";
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
      isCodexBot(review?.user) &&
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

  const commentsResult = fetchComments();
  if (commentsResult.error) {
    console.log(`::warning::Could not query Codex review comments: ${commentsResult.error}`);
    finish(
      false,
      "codex-status-error",
      "",
      "Could not verify whether Codex posted a clean review for the current head; falling back to Claude."
    );
    break;
  }

  let cleanComment;
  let resolutionError = "";
  const headSha = process.env.HEAD_SHA.toLowerCase();
  for (const comment of commentsResult.comments) {
    if (!isCodexBot(comment?.user)) continue;
    const abbreviatedSha = reviewedCommit(comment?.body).toLowerCase();
    if (!abbreviatedSha || !headSha.startsWith(abbreviatedSha)) continue;

    if (abbreviatedSha.length === 40) {
      cleanComment = comment;
      break;
    }

    const resolved = resolveCommit(abbreviatedSha);
    if (resolved.error) {
      resolutionError = resolved.error;
      continue;
    }
    if (resolved.sha.toLowerCase() === headSha) {
      cleanComment = comment;
      break;
    }
  }

  if (!cleanComment && resolutionError) {
    console.log(`::warning::Could not resolve Codex reviewed commit: ${resolutionError}`);
    finish(
      false,
      "codex-status-error",
      "",
      "Could not resolve the reviewed commit to a unique full SHA; falling back to Claude."
    );
    break;
  }

  if (cleanComment) {
    finish(
      true,
      "codex-clean-comment-found",
      "",
      `Verified Codex clean-review comment #${cleanComment.id} for head ${process.env.HEAD_SHA}; Claude fallback is not needed.`
    );
    break;
  }

  if (remaining === 0) {
    finish(
      false,
      "codex-review-timeout",
      "",
      `No verified Codex review result was found for head ${process.env.HEAD_SHA} after ${waitSeconds} second(s); falling back to Claude.`
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
