// What counts as Codex having reviewed a commit. One definition, shared by
// this action's check.js and by scripts/merge-ready.js, so "reviewed" cannot
// mean one thing to the reviewer workflow and another to the merge check.
//
// Everything here matches positively: a comment counts only when it has the
// exact shape of a verdict and names the commit. Anything else Codex posts --
// a usage-limit notice, an error, a reply -- matches nothing and is not a
// review.

const CODEX_LOGIN = "chatgpt-codex-connector[bot]";
const CODEX_USER_ID = 199175422;
const SUBMITTED_STATES = new Set(["COMMENTED", "APPROVED", "CHANGES_REQUESTED"]);

function isCodexBot(user) {
  return (
    user?.id === CODEX_USER_ID &&
    user?.login === CODEX_LOGIN &&
    user?.type === "Bot"
  );
}

function timestamp(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(value)) return NaN;
  return Date.parse(value);
}

const SUMMARY_MARKER = "<!-- codex-pull-request-review-summary -->";

// Since 2026-10-16 Codex opens its comments with this marker and a blank
// line (first seen on crossroads-evolution; all 23 clean verdicts there up to
// 2026-11-14 carry it). The clean verdict below was anchored to the start of
// the body, so it matched none of them and every clean Codex review was
// reported as no review.
const RECEIPT_PREFIX = /^<!-- codex-review-receipt:v1 -->\r?\n\r?\n/;

// Every commit a Codex comment vouches for, with the reason to report. Two
// formats: the one-line clean verdict, and the summary table Codex edits in
// place (first seen on crossroads-ci#67, 2026-09-29), where a "Code Review"
// row marked Completed means Codex finished reviewing that commit. Findings
// still arrive as a formal review, which callers look for first.
function reviewedCommits(body) {
  if (typeof body !== "string") return [];
  const clean = body.replace(RECEIPT_PREFIX, "").match(
    /^Codex Review: Didn't find any major issues\.[^\r\n]*\r?\n\r?\n\*\*Reviewed commit:\*\* `([0-9a-f]{7,40})`(?:\r?\n|$)/
  )?.[1];
  if (clean) return [{ sha: clean, reason: "codex-clean-comment-found" }];
  if (!body.startsWith(SUMMARY_MARKER)) return [];
  return [
    ...body.matchAll(
      /^\| [^|\r\n]*\*\*Code Review\*\* \| ✅ \*\*Completed\*\*([^|\r\n]*)\| `([0-9a-f]{7,40})` \|/gm
    ),
  ].map((m) => ({
    sha: m[2], reason: "codex-summary-completed",
    completedAt: timestamp(m[1].match(/<relative-time datetime="([^"]+)"/)?.[1]),
  }));
}

module.exports = {
  CODEX_LOGIN,
  CODEX_USER_ID,
  SUBMITTED_STATES,
  isCodexBot,
  reviewedCommits,
  timestamp,
};
