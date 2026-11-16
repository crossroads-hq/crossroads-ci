#!/usr/bin/env node
// Is this pull request, or the stack it belongs to, ready?
//
//   node scripts/merge-ready.js --repo crossroads-hq/crossroads-evolution --pr 826
//
// Read-only. For the named pull request and every open pull request stacked
// under or on it, it checks, on the commit at the top of each branch:
//
//   aligned   the branch contains the tip of its base (main, or the pull
//             request below it in the stack);
//   reviewed  a review of that exact commit exists -- Codex, the Claude
//             fallback, or a person's approval. A usage-limit notice is not a
//             review: only a verdict naming the commit counts;
//   threads   every review thread is resolved;
//   checks    the required check passed on that commit.
//
// A pull request with the first three is READY TO MARK READY while it is a
// draft, so the long build runs once, on a commit already reviewed. With all
// four, and not a draft, it is MERGEABLE, unless a pull request below it in
// the stack is not: then it is BLOCKED BELOW. A fix pushed after a review makes a
// new commit, which needs its own review: that is what "every fix reviewed
// again" means here.
//
// Anything GitHub did not answer, or answered incompletely, is a reason the
// pull request is not ready -- never a reason to skip the condition.
//
// Exit status: 0 when every pull request in the stack is READY TO MARK READY
// or MERGEABLE, 1 otherwise, 2 for a usage error.

const { spawnSync } = require("node:child_process");
const {
  SUBMITTED_STATES,
  isCodexBot,
  reviewedCommits,
} = require("../actions/await-codex-review/evidence.js");

const REVIEW_WORKFLOW = "crossroads-hq/crossroads-ci/.github/workflows/_ai-review.yml@";
const CLAUDE_EVIDENCE_STEP = "Confirm a review actually reached the pull request";

// `gh api`, answering { data } or { error }. Lists are fetched whole: a
// partial list would read as "no unresolved threads" or "no review".
function ghApi(endpoint, { paginate = false } = {}) {
  const args = ["api", endpoint, ...(paginate ? ["--paginate", "--slurp"] : [])];
  const proc = spawnSync("gh", args, { encoding: "utf8", maxBuffer: 1 << 28 });
  if (proc.status !== 0) return { error: (proc.stderr || "").trim() || `gh exited ${proc.status}` };
  try {
    const data = JSON.parse(proc.stdout);
    if (!paginate) return { data };
    if (!Array.isArray(data)) return { error: "paginated response was not a list of pages" };
    return { data };
  } catch (error) {
    return { error: `response was not valid JSON: ${error.message}` };
  }
}

function ghGraphql(query, variables) {
  const args = ["api", "graphql", "-f", `query=${query}`];
  for (const [name, value] of Object.entries(variables)) {
    if (value === null || value === undefined) continue;
    args.push(typeof value === "number" ? "-F" : "-f", `${name}=${value}`);
  }
  const proc = spawnSync("gh", args, { encoding: "utf8", maxBuffer: 1 << 28 });
  if (proc.status !== 0) return { error: (proc.stderr || "").trim() || `gh exited ${proc.status}` };
  try {
    const body = JSON.parse(proc.stdout);
    if (body.errors?.length) return { error: body.errors.map((e) => e.message).join("; ") };
    return { data: body.data };
  } catch (error) {
    return { error: `response was not valid JSON: ${error.message}` };
  }
}

// Pages of a list endpoint, flattened. `key` names the list inside each page
// for the endpoints that wrap it ({ workflow_runs: [...] }).
function list(api, endpoint, key) {
  const result = api(endpoint, { paginate: true });
  if (result.error) return result;
  const items = [];
  for (const page of result.data) {
    const rows = key ? page?.[key] : page;
    if (!Array.isArray(rows)) return { error: `${endpoint}: a page was not a list` };
    items.push(...rows);
  }
  return { data: items };
}

const isSha = (value) => typeof value === "string" && /^[0-9a-f]{40}$/.test(value);

// The open pull requests stacked with `number`: down to the one based on a
// branch no open pull request owns, and up through everything based on it.
// Bottom first.
//
// A branch is a repository and a name: two forks may both have a `patch-1`,
// and neither is the branch of that name in this repository. A pull request
// whose fork was deleted has no head repository, so its branch is its own.
const headKey = (p) => (p.head.repo ? `${p.head.repo.full_name}:${p.head.ref}` : `#${p.number}:${p.head.ref}`);
const baseKey = (p) => `${p.base.repo.full_name}:${p.base.ref}`;

function stackOf(pulls, number) {
  const start = pulls.find((p) => p.number === number);
  if (!start) return { error: `#${number} is not an open pull request` };
  const byHead = new Map();
  for (const p of pulls) {
    const key = headKey(p);
    byHead.set(key, [...(byHead.get(key) || []), p]);
  }
  // Two pull requests from one branch are ambiguous only where the stack
  // passes through that branch.
  const owner = (key) => {
    const owners = byHead.get(key) || [];
    return owners.length > 1
      ? { error: `two open pull requests share the branch ${owners[0].head.ref}; the stack is ambiguous` }
      : { pull: owners[0] };
  };
  const own = owner(headKey(start));
  if (own.error) return own;
  let bottom = start;
  const seen = new Set([bottom.number]);
  for (;;) {
    const below = owner(baseKey(bottom));
    if (below.error) return below;
    if (!below.pull) break;
    bottom = below.pull;
    if (seen.has(bottom.number)) return { error: "the stack's bases form a loop" };
    seen.add(bottom.number);
  }
  const ordered = [];
  const queue = [bottom];
  while (queue.length > 0) {
    const current = queue.shift();
    ordered.push(current);
    const above = pulls.filter((p) => baseKey(p) === headKey(current)).sort((a, b) => a.number - b.number);
    for (const p of above) {
      const check = owner(headKey(p));
      if (check.error) return check;
    }
    queue.push(...above);
  }
  return { data: ordered };
}

function aligned(api, repo, pull) {
  const result = api(
    `repos/${repo}/compare/${encodeURIComponent(pull.base.ref)}...${encodeURIComponent(pull.head.sha)}`
  );
  if (result.error) return { ok: false, detail: `could not compare with ${pull.base.ref}: ${result.error}` };
  const behind = result.data?.behind_by;
  if (!Number.isInteger(behind)) return { ok: false, detail: `comparison with ${pull.base.ref} was malformed` };
  return behind === 0
    ? { ok: true, detail: `contains the tip of ${pull.base.ref}` }
    : { ok: false, detail: `${behind} commit(s) behind ${pull.base.ref}` };
}

// A Codex comment vouches for an abbreviated commit. It counts for this head
// only when GitHub resolves the abbreviation to exactly this commit.
function vouchesFor(api, repo, sha, head) {
  const short = sha.toLowerCase();
  if (!head.startsWith(short)) return false;
  if (short.length === 40) return true;
  const resolved = api(`repos/${repo}/commits/${short}`);
  return !resolved.error && resolved.data?.sha?.toLowerCase() === head;
}

function fileAt(api, repo, path, ref) {
  const file = api(
    `repos/${repo}/contents/${path.split("/").map(encodeURIComponent).join("/")}?ref=${encodeURIComponent(ref)}`
  );
  return file.error || typeof file.data?.content !== "string"
    ? null
    : Buffer.from(file.data.content, "base64").toString("utf8");
}

// A confirmed Claude fallback review of this commit: a successful "AI review"
// job, with its evidence step passed, in a run on this commit of a workflow
// that the default branch has calling the fleet reviewer, and that this commit
// leaves exactly as the default branch has it, triggered by this pull request
// on its present base. A pull request can add a
// workflow with a job of that name, or rewrite an existing caller so a local
// job of that name passes a step of that name; either way its copy of the file
// differs from the trusted one, and the run proves nothing. A pull request that
// has to change the caller needs a Codex or a person's review instead.
function claudeReviewed(api, repo, pull) {
  const runs = list(api, `repos/${repo}/actions/runs?head_sha=${pull.head.sha}&per_page=100`, "workflow_runs");
  if (runs.error) return { error: runs.error };
  const trusted = new Map();
  for (const run of runs.data) {
    if (typeof run?.path !== "string" || !Number.isInteger(run?.id)) return { error: "a workflow run was malformed" };
    if (run.head_sha !== pull.head.sha) continue;
    // The evidence step proves delivery to the pull request that triggered the
    // run. Another pull request at the same commit, or this one before its base
    // was changed, was a review of a different diff. GitHub lists no pull
    // request on a fork's run, so that run stays unverified.
    const forThis = Array.isArray(run.pull_requests) && run.pull_requests.some(
      (pr) => pr?.number === pull.number && pr?.base?.ref === pull.base.ref
    );
    if (!forThis) continue;
    if (!trusted.has(run.path)) {
      const base = fileAt(api, repo, run.path, pull.base.repo.default_branch);
      trusted.set(
        run.path,
        base !== null && base.includes(REVIEW_WORKFLOW) && fileAt(api, repo, run.path, pull.head.sha) === base
      );
    }
    if (!trusted.get(run.path)) continue;
    const jobs = list(api, `repos/${repo}/actions/runs/${run.id}/jobs?per_page=100`, "jobs");
    if (jobs.error) return { error: jobs.error };
    const confirmed = jobs.data.some(
      (job) =>
        typeof job?.name === "string" &&
        job.name.endsWith("AI review") &&
        job.conclusion === "success" &&
        Array.isArray(job.steps) &&
        job.steps.some((step) => step?.name === CLAUDE_EVIDENCE_STEP && step?.conclusion === "success")
    );
    if (confirmed) return { reviewed: true };
  }
  return { reviewed: false };
}

function reviewed(api, repo, pull) {
  const head = pull.head.sha;
  const reviews = list(api, `repos/${repo}/pulls/${pull.number}/reviews?per_page=100`);
  if (reviews.error) return { ok: false, detail: `could not read reviews: ${reviews.error}` };
  const atHead = reviews.data.filter((r) => r?.commit_id === head && r?.submitted_at);

  // The list is the whole history. What stands is each reviewer's latest
  // decision: an approval followed by a request for changes is a request for
  // changes, on whichever commit it was made, until it is dismissed or the
  // reviewer approves again. A comment does not replace a decision.
  const standing = new Map();
  for (const r of reviews.data) {
    if (!["APPROVED", "CHANGES_REQUESTED", "DISMISSED"].includes(r?.state)) continue;
    const who = r.user?.id;
    const at = Date.parse(r.submitted_at);
    if (!Number.isInteger(who) || !Number.isFinite(at)) return { ok: false, detail: "a review was malformed" };
    if (!standing.has(who) || at >= standing.get(who).at) standing.set(who, { at, review: r });
  }
  const decisions = [...standing.values()].map((entry) => entry.review);
  const refused = decisions.filter((r) => r.state === "CHANGES_REQUESTED");
  if (refused.length > 0) {
    return { ok: false, detail: `changes requested by ${refused.map((r) => r.user?.login).join(", ")}` };
  }

  if (atHead.some((r) => isCodexBot(r.user) && SUBMITTED_STATES.has(r.state))) {
    return { ok: true, detail: "Codex reviewed this commit" };
  }
  if (decisions.some((r) => r.user?.type === "User" && r.state === "APPROVED" && r.commit_id === head)) {
    return { ok: true, detail: "approved by a person on this commit" };
  }

  // A dismissed Codex review of this commit makes a Completed summary row
  // ambiguous: the row may describe the dismissed review. The reviewer
  // workflow settles that by event times; this check takes the safer answer.
  const dismissed = reviews.data.some(
    (r) => isCodexBot(r?.user) && r?.commit_id === head && r?.state === "DISMISSED"
  );
  const comments = list(api, `repos/${repo}/issues/${pull.number}/comments?per_page=100`);
  if (comments.error) return { ok: false, detail: `could not read comments: ${comments.error}` };
  for (const comment of comments.data) {
    if (!isCodexBot(comment?.user)) continue;
    for (const { sha, reason } of reviewedCommits(comment.body)) {
      if (reason === "codex-summary-completed" && dismissed) continue;
      if (vouchesFor(api, repo, sha, head)) return { ok: true, detail: "Codex reviewed this commit and found nothing" };
    }
  }

  const claude = claudeReviewed(api, repo, pull);
  if (claude.error) return { ok: false, detail: `could not read the Claude review runs: ${claude.error}` };
  if (claude.reviewed) return { ok: true, detail: "the Claude fallback reviewed this commit" };

  const earlier = reviews.data.some((r) => isCodexBot(r?.user) && SUBMITTED_STATES.has(r?.state));
  return {
    ok: false,
    detail: earlier
      ? "no review of this commit; an earlier commit was reviewed, and the changes since were not"
      : "no review of this commit",
  };
}

const THREADS_QUERY = `query($owner:String!,$name:String!,$number:Int!,$after:String){
  repository(owner:$owner,name:$name){pullRequest(number:$number){
    reviewThreads(first:100,after:$after){
      pageInfo{hasNextPage endCursor}
      nodes{isResolved comments(first:1){nodes{url author{login}}}}}}}}`;

function threads(graphql, repo, pull) {
  const [owner, name] = repo.split("/");
  const open = [];
  let total = 0;
  let after = null;
  for (let page = 0; page < 50; page += 1) {
    const result = graphql(THREADS_QUERY, { owner, name, number: pull.number, after });
    if (result.error) return { ok: false, detail: `could not read review threads: ${result.error}` };
    const connection = result.data?.repository?.pullRequest?.reviewThreads;
    if (!Array.isArray(connection?.nodes) || typeof connection?.pageInfo?.hasNextPage !== "boolean") {
      return { ok: false, detail: "review threads response was malformed" };
    }
    for (const node of connection.nodes) {
      if (typeof node?.isResolved !== "boolean") return { ok: false, detail: "a review thread was malformed" };
      total += 1;
      if (!node.isResolved) open.push(node.comments?.nodes?.[0]?.url || "(no link)");
    }
    if (!connection.pageInfo.hasNextPage) {
      return open.length === 0
        ? { ok: true, detail: total === 0 ? "no review threads" : `all ${total} thread(s) resolved` }
        : { ok: false, detail: `${open.length} of ${total} thread(s) unresolved`, links: open };
    }
    after = connection.pageInfo.endCursor;
    if (typeof after !== "string" || after === "") return { ok: false, detail: "review threads paging was malformed" };
  }
  return { ok: false, detail: "review threads did not finish paging" };
}

// The newest run of the required check. Where the check also reported on the
// pull request's test merge commit, GitHub goes by that result, so this does
// too; otherwise the result on the head commit.
function checks(api, repo, pull, requiredCheck) {
  const on = (sha) => {
    const runs = list(
      api,
      `repos/${repo}/commits/${sha}/check-runs?check_name=${encodeURIComponent(requiredCheck)}&per_page=100`,
      "check_runs"
    );
    return runs.error ? runs : { data: runs.data.filter((r) => r?.name === requiredCheck) };
  };
  let named = { data: [] };
  if (pull.merge_commit_sha) named = on(pull.merge_commit_sha);
  if (!named.error && named.data.length === 0) named = on(pull.head.sha);
  if (named.error) return { state: "unknown", detail: `could not read ${requiredCheck}: ${named.error}` };
  named = named.data;
  if (named.length === 0) return { state: "missing", detail: `${requiredCheck} has not run on this commit` };
  const latest = named.reduce((a, b) => (String(b.started_at) > String(a.started_at) ? b : a));
  if (latest.status !== "completed") return { state: "pending", detail: `${requiredCheck} is running` };
  return latest.conclusion === "success"
    ? { state: "passed", detail: `${requiredCheck} passed` }
    : { state: "failed", detail: `${requiredCheck} ended ${latest.conclusion}` };
}

function verdict(pull, facts) {
  const blockers = ["aligned", "reviewed", "threads"].filter((name) => !facts[name].ok);
  if (blockers.length > 0) return "NOT READY";
  if (pull.draft) return "READY TO MARK READY";
  if (facts.checks.state === "passed") return "MERGEABLE";
  return facts.checks.state === "failed" ? "CHECKS FAILED" : "WAITING FOR CHECKS";
}

// The open pull requests, and the stack `number` is in.
function readStack(api, repo, number) {
  const pulls = list(api, `repos/${repo}/pulls?state=open&per_page=100`);
  if (pulls.error) return { error: `could not list open pull requests: ${pulls.error}` };
  for (const p of pulls.data) {
    if (!Number.isInteger(p?.number) || !isSha(p?.head?.sha) || typeof p?.head?.ref !== "string" ||
        typeof p?.base?.ref !== "string" || typeof p?.draft !== "boolean" ||
        typeof p?.base?.repo?.full_name !== "string" || !isSha(p?.base?.sha) ||
        (p.merge_commit_sha != null && !isSha(p.merge_commit_sha)) ||
        (p.head.repo !== null && typeof p.head.repo?.full_name !== "string") ||
        typeof p?.base?.repo?.default_branch !== "string") {
      return { error: "an open pull request was malformed" };
    }
  }
  return stackOf(pulls.data, number);
}

function assess({ repo, number, requiredCheck = "PR Validation" }, { api = ghApi, graphql = ghGraphql } = {}) {
  const stack = readStack(api, repo, number);
  if (stack.error) return { error: stack.error };

  const rows = stack.data.map((pull) => {
    const facts = {
      aligned: aligned(api, repo, pull),
      reviewed: reviewed(api, repo, pull),
      threads: threads(graphql, repo, pull),
      checks: checks(api, repo, pull, requiredCheck),
    };
    return {
      number: pull.number,
      title: pull.title,
      draft: pull.draft,
      head: pull.head.sha,
      base: pull.base.ref,
      facts,
      verdict: verdict(pull, facts),
    };
  });
  // A pull request merges only after every one below it. Its own green build
  // does not make it mergeable while a lower one is still waiting, and GitHub
  // shows that as "blocked downstack".
  // The blocker is found along each pull request's own bases: two pull
  // requests on the same one do not block each other. Rows are bottom first,
  // so the one below is settled before the ones on it.
  const rowOn = new Map(stack.data.map((pull, i) => [headKey(pull), rows[i]]));
  stack.data.forEach((pull, i) => {
    const lower = rowOn.get(baseKey(pull));
    if (!lower || lower.verdict === "MERGEABLE") return;
    const blocker = lower.blockedBy || lower.number;
    if (rows[i].verdict === "MERGEABLE") rows[i].verdict = "BLOCKED BELOW";
    rows[i].blockedBy = blocker;
  });
  // Everything above was read for the commits the first listing gave. A push,
  // a new base, a base branch that moved on, or a change of draft state since
  // then leaves the answer about a stack that no longer exists.
  const now = readStack(api, repo, number);
  if (now.error) return { error: `could not confirm the stack was unchanged: ${now.error}` };
  const shape = (pulls) =>
    pulls.map((p) => `${p.number} ${p.head.sha} ${baseKey(p)} ${p.base.sha} ${p.draft}`).join("\n");
  if (shape(now.data) !== shape(stack.data)) {
    return { error: "the stack changed while it was being read; run the check again" };
  }
  const ready = rows.every((row) => row.verdict === "READY TO MARK READY" || row.verdict === "MERGEABLE");
  return { rows, ready };
}

function render({ rows, ready }) {
  const lines = [];
  for (const row of rows) {
    lines.push(`#${row.number}  ${row.verdict}  ${row.draft ? "draft" : "ready"}  ${row.head.slice(0, 8)}  ${row.title || ""}`);
    for (const name of ["aligned", "reviewed", "threads"]) {
      lines.push(`    ${row.facts[name].ok ? "ok  " : "NO  "} ${name}: ${row.facts[name].detail}`);
      for (const link of row.facts[name].links || []) lines.push(`           ${link}`);
    }
    lines.push(`    ${row.facts.checks.state === "passed" ? "ok  " : "--  "} checks: ${row.facts.checks.detail}`);
    if (row.verdict === "BLOCKED BELOW") lines.push(`    --   below: waits for #${row.blockedBy}, lower in the stack`);
  }
  lines.push("");
  if (ready) lines.push(`All ${rows.length} pull request(s): ready.`);
  for (const [label, name] of [
    ["Not ready", "NOT READY"],
    ["Checks failed", "CHECKS FAILED"],
    ["Waiting for checks", "WAITING FOR CHECKS"],
    ["Blocked by a lower pull request", "BLOCKED BELOW"],
  ]) {
    const numbers = rows.filter((r) => r.verdict === name).map((r) => `#${r.number}`);
    if (numbers.length > 0) lines.push(`${label}: ${numbers.join(", ")}.`);
  }
  return lines.join("\n");
}

function main(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i += 2) {
    const value = argv[i + 1];
    if (!["--repo", "--pr", "--required-check"].includes(argv[i]) || value === undefined) {
      console.error("usage: merge-ready.js --repo OWNER/NAME --pr NUMBER [--required-check NAME]");
      return 2;
    }
    options[argv[i]] = value;
  }
  if (!/^[\w.-]+\/[\w.-]+$/.test(options["--repo"] || "") || !/^[1-9]\d*$/.test(options["--pr"] || "")) {
    console.error("usage: merge-ready.js --repo OWNER/NAME --pr NUMBER [--required-check NAME]");
    return 2;
  }
  const result = assess({
    repo: options["--repo"],
    number: Number(options["--pr"]),
    requiredCheck: options["--required-check"] || "PR Validation",
  });
  if (result.error) {
    console.error(`Not ready: ${result.error}.`);
    return 1;
  }
  console.log(render(result));
  return result.ready ? 0 : 1;
}

if (require.main === module) process.exit(main(process.argv.slice(2)));

module.exports = { assess, render, stackOf };
