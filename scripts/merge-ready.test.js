// Tests for merge-ready.js. `assess` takes the two GitHub readers as
// arguments, so each case states the answers GitHub gives and reads the
// verdict. Run with:
//
//   node --test scripts/merge-ready.test.js
const test = require("node:test");
const assert = require("node:assert");

const { assess, render, stackOf } = require("./merge-ready.js");

const REPO = "crossroads-hq/demo";
const CODEX = { id: 199175422, login: "chatgpt-codex-connector[bot]", type: "Bot" };
const sha = (letter) => letter.repeat(40);

const pull = (number, head, base, { draft = true, commit = sha("a") } = {}) => ({
  number, title: `PR ${number}`, draft,
  head: { ref: head, sha: commit },
  base: { ref: base, repo: { default_branch: "main" } },
});

const codexReview = (commit, state = "COMMENTED") => ({
  id: 1, user: CODEX, commit_id: commit, state, submitted_at: "2026-11-14T20:12:18Z",
});
const cleanComment = (commit) => ({
  user: CODEX,
  body: `<!-- codex-review-receipt:v1 -->\n\nCodex Review: Didn't find any major issues. Nice work!\n\n**Reviewed commit:** \`${commit}\``,
});

// One pull request, #7 on main, described by what GitHub answers about it.
// Endpoints are matched by what they contain; anything unlisted is a failure,
// so a test cannot pass by reading something it did not set up.
function world({
  pulls = [pull(7, "feature", "main")],
  behind = 0,
  reviews = [],
  comments = [],
  runs = [],
  jobs = {},
  workflows = {},
  checkRuns = [],
  threadPages = [[]],
  fail = [],
} = {}) {
  const api = (endpoint) => {
    if (fail.some((part) => endpoint.includes(part))) return { error: "HTTP 502" };
    if (endpoint.includes("/pulls?state=open")) return { data: [pulls] };
    if (endpoint.includes("/compare/")) return { data: { behind_by: typeof behind === "function" ? behind(endpoint) : behind } };
    if (endpoint.includes("/reviews")) return { data: [reviews] };
    if (endpoint.includes("/issues/")) return { data: [comments] };
    if (endpoint.includes("/check-runs")) return { data: [{ check_runs: checkRuns }] };
    if (endpoint.includes("/jobs")) return { data: [{ jobs: jobs[endpoint.match(/runs\/(\d+)\/jobs/)[1]] || [] }] };
    if (endpoint.includes("/actions/runs?head_sha=")) return { data: [{ workflow_runs: runs }] };
    if (endpoint.includes("/contents/")) {
      const path = decodeURIComponent(endpoint.match(/contents\/(.+)\?ref=main$/)[1]);
      return path in workflows
        ? { data: { content: Buffer.from(workflows[path]).toString("base64") } }
        : { error: "HTTP 404" };
    }
    if (endpoint.includes("/commits/")) return { data: { sha: sha("a") } };
    return { error: `no answer set up for ${endpoint}` };
  };
  // Every pull request has the same threads; `after` says which page is asked for.
  const graphql = (query, variables) => {
    if (fail.includes("graphql")) return { error: "HTTP 502" };
    let page = variables.after ? Number(variables.after.replace("cursor", "")) : 0;
    const nodes = threadPages[page];
    page += 1;
    return {
      data: { repository: { pullRequest: { reviewThreads: {
        pageInfo: { hasNextPage: page < threadPages.length, endCursor: `cursor${page}` },
        nodes,
      } } } },
    };
  };
  return { api, graphql };
}

const thread = (isResolved, url = "https://example.test/t") => ({
  isResolved, comments: { nodes: [{ url, author: { login: CODEX.login } }] },
});
const one = (setup) => assess({ repo: REPO, number: 7 }, world(setup)).rows[0];
const REVIEWED = { reviews: [codexReview(sha("a"))] };

test("a reviewed, aligned draft with no open threads is ready to mark ready", () => {
  const row = one(REVIEWED);
  assert.equal(row.verdict, "READY TO MARK READY");
  assert.equal(assess({ repo: REPO, number: 7 }, world(REVIEWED)).ready, true);
});

test("the build is not asked of a draft, and is asked of a ready pull request", () => {
  const ready = { ...REVIEWED, pulls: [pull(7, "feature", "main", { draft: false })] };
  assert.equal(one(ready).verdict, "WAITING FOR CHECKS");
  const run = (status, conclusion, started_at = "2026-11-14T20:00:00Z") => ({ name: "PR Validation", status, conclusion, started_at });
  assert.equal(one({ ...ready, checkRuns: [run("in_progress", null)] }).verdict, "WAITING FOR CHECKS");
  assert.equal(one({ ...ready, checkRuns: [run("completed", "failure")] }).verdict, "CHECKS FAILED");
  assert.equal(one({ ...ready, checkRuns: [run("completed", "success")] }).verdict, "MERGEABLE");
  // A re-run replaces the earlier result, whichever way it went.
  assert.equal(
    one({ ...ready, checkRuns: [run("completed", "success"), run("completed", "failure", "2026-11-14T22:00:00Z")] }).verdict,
    "CHECKS FAILED"
  );
});

test("a pull request behind its base is not ready", () => {
  const row = one({ ...REVIEWED, behind: 5 });
  assert.equal(row.verdict, "NOT READY");
  assert.match(row.facts.aligned.detail, /5 commit\(s\) behind main/);
});

test("a review of an earlier commit does not cover the commits pushed since", () => {
  const row = one({ reviews: [codexReview(sha("b"))] });
  assert.equal(row.verdict, "NOT READY");
  assert.match(row.facts.reviewed.detail, /changes since were not/);
});

test("a clean Codex verdict naming this commit is a review", () => {
  assert.equal(one({ comments: [cleanComment(sha("a"))] }).verdict, "READY TO MARK READY");
  assert.equal(one({ comments: [cleanComment("aaaaaaaaaa")] }).verdict, "READY TO MARK READY");
  assert.equal(one({ comments: [cleanComment(sha("b"))] }).verdict, "NOT READY");
});

test("a usage-limit notice is not a review, from any bot and in any form", () => {
  const notice = "You have reached your Codex usage limits for code reviews. You can see your limits in the Codex usage dashboard.";
  const copilot = { id: 175728472, login: "copilot-pull-request-reviewer[bot]", type: "Bot" };
  for (const setup of [
    { comments: [{ user: CODEX, body: notice }] },
    { comments: [{ user: CODEX, body: `<!-- codex-review-receipt:v1 -->\n\n${notice}` }] },
    { comments: [{ user: copilot, body: "Copilot wasn't able to review this pull request because you have reached your quota." }] },
    // Even posted as a formal review of this commit, a bot other than Codex does not count.
    { reviews: [{ id: 2, user: copilot, commit_id: sha("a"), state: "COMMENTED", submitted_at: "2026-11-14T20:12:18Z" }] },
  ]) {
    const row = one(setup);
    assert.equal(row.verdict, "NOT READY", JSON.stringify(setup));
    assert.equal(row.facts.reviewed.detail, "no review of this commit");
  }
});

test("a comment from someone else quoting the verdict is not a review", () => {
  const forged = { ...cleanComment(sha("a")), user: { id: 1, login: "chatgpt-codex-connector[bot]", type: "Bot" } };
  assert.equal(one({ comments: [forged] }).verdict, "NOT READY");
});

test("a person's approval of this commit is a review; their comment is not", () => {
  const person = { id: 5, login: "owner", type: "User" };
  const by = (state, commit = sha("a")) => ({ id: 3, user: person, commit_id: commit, state, submitted_at: "2026-11-14T20:12:18Z" });
  assert.equal(one({ reviews: [by("APPROVED")] }).verdict, "READY TO MARK READY");
  assert.equal(one({ reviews: [by("COMMENTED")] }).verdict, "NOT READY");
  assert.equal(one({ reviews: [by("APPROVED", sha("b"))] }).verdict, "NOT READY");
});

test("a dismissed Codex review of this commit makes a completed summary row count for nothing", () => {
  const summary = {
    user: CODEX,
    body: `<!-- codex-pull-request-review-summary -->\n| x **Code Review** | ✅ **Completed** | \`${sha("a")}\` |`,
  };
  assert.equal(one({ comments: [summary] }).verdict, "READY TO MARK READY");
  assert.equal(one({ comments: [summary], reviews: [codexReview(sha("a"), "DISMISSED")] }).verdict, "NOT READY");
});

test("the Claude fallback counts only from a workflow the base branch has calling the fleet reviewer", () => {
  const job = { name: "ai-review / AI review", conclusion: "success", steps: [{ name: "Confirm a review actually reached the pull request", conclusion: "success" }] };
  const calls = "uses: crossroads-hq/crossroads-ci/.github/workflows/_ai-review.yml@68a5403e";
  const setup = (extra) => ({ runs: [{ id: 11, path: ".github/workflows/validate.yml" }], jobs: { 11: [job] }, ...extra });

  assert.equal(one(setup({ workflows: { ".github/workflows/validate.yml": calls } })).verdict, "READY TO MARK READY");
  // The pull request added the workflow: the base branch has no such file.
  assert.equal(one(setup({ workflows: {} })).verdict, "NOT READY");
  // The base branch has the file, but it does not call the reviewer.
  assert.equal(one(setup({ workflows: { ".github/workflows/validate.yml": "jobs: {}" } })).verdict, "NOT READY");
  // The job succeeded without its evidence step: it skipped, it did not review.
  assert.equal(
    one(setup({ workflows: { ".github/workflows/validate.yml": calls }, jobs: { 11: [{ ...job, steps: [] }] } })).verdict,
    "NOT READY"
  );
});

test("one unresolved thread, on any page, is not ready, and is linked", () => {
  const row = one({ ...REVIEWED, threadPages: [[thread(true)], [thread(false, "https://example.test/open")]] });
  assert.equal(row.verdict, "NOT READY");
  assert.match(row.facts.threads.detail, /1 of 2 thread\(s\) unresolved/);
  assert.deepEqual(row.facts.threads.links, ["https://example.test/open"]);
  assert.equal(one({ ...REVIEWED, threadPages: [[thread(true)], [thread(true)]] }).verdict, "READY TO MARK READY");
});

test("what GitHub did not answer is a reason the pull request is not ready", () => {
  for (const part of ["/compare/", "/reviews", "/issues/", "/actions/runs?head_sha=", "graphql"]) {
    // The comments and runs are read only when no formal review settles it.
    const setup = ["/issues/", "/actions/runs?head_sha="].includes(part) ? { fail: [part] } : { ...REVIEWED, fail: [part] };
    const row = one(setup);
    assert.equal(row.verdict, "NOT READY", part);
    assert.match(JSON.stringify(row.facts), /could not/, part);
  }
  assert.match(assess({ repo: REPO, number: 7 }, world({ fail: ["/pulls?state=open"] })).error, /could not list/);
  const malformed = world(REVIEWED);
  const row = assess({ repo: REPO, number: 7 }, { ...malformed, graphql: () => ({ data: {} }) }).rows[0];
  assert.equal(row.verdict, "NOT READY");
});

test("a stack is read bottom first from any of its pull requests, each against the one below", () => {
  const pulls = [
    pull(12, "top", "middle", { commit: sha("c") }),
    pull(10, "bottom", "main", { commit: sha("a") }),
    pull(11, "middle", "bottom", { commit: sha("b") }),
    pull(99, "unrelated", "main", { commit: sha("d") }),
  ];
  assert.deepEqual(stackOf(pulls, 11).data.map((p) => p.number), [10, 11, 12]);
  assert.deepEqual(stackOf(pulls, 12).data.map((p) => p.number), [10, 11, 12]);
  assert.match(stackOf(pulls, 5).error, /not an open pull request/);

  // The middle branch does not contain the bottom's tip; nothing else is behind.
  const result = assess(
    { repo: REPO, number: 12 },
    world({
      pulls,
      behind: (endpoint) => (endpoint.includes(`/compare/bottom...${sha("b")}`) ? 2 : 0),
      reviews: [codexReview(sha("a")), codexReview(sha("b")), codexReview(sha("c"))],
    })
  );
  assert.deepEqual(result.rows.map((r) => r.verdict), ["READY TO MARK READY", "NOT READY", "READY TO MARK READY"]);
  assert.equal(result.ready, false);
  assert.match(render(result), /Not ready: #11\.$/);
});

test("a green pull request above one still building is blocked below, not mergeable", () => {
  const pulls = [
    pull(10, "bottom", "main", { draft: false, commit: sha("a") }),
    pull(11, "middle", "bottom", { draft: false, commit: sha("b") }),
    pull(12, "top", "middle", { draft: false, commit: sha("c") }),
  ];
  const passed = { name: "PR Validation", status: "completed", conclusion: "success", started_at: "2026-11-14T20:00:00Z" };
  const setup = { pulls, reviews: [codexReview(sha("a")), codexReview(sha("b")), codexReview(sha("c"))] };
  const base = world(setup);
  // Only the middle pull request's build has not finished.
  const api = (endpoint) =>
    endpoint.includes("/check-runs")
      ? { data: [{ check_runs: endpoint.includes(sha("b")) ? [] : [passed] }] }
      : base.api(endpoint);
  const result = assess({ repo: REPO, number: 12 }, { api, graphql: base.graphql });
  assert.deepEqual(result.rows.map((r) => r.verdict), ["MERGEABLE", "WAITING FOR CHECKS", "BLOCKED BELOW"]);
  assert.equal(result.rows[2].blockedBy, 11);
  assert.equal(result.ready, false);
  assert.match(render(result), /Blocked by a lower pull request: #12\.$/);
});

test("two open pull requests on one branch make the stack ambiguous", () => {
  assert.match(stackOf([pull(1, "same", "main"), pull(2, "same", "main")], 1).error, /ambiguous/);
});
