// Queue-wait report for a workflow run. Informational only: every path ends
// in exit 0, because this runs inside the gate job and must never change a
// required check's result. Missing or incomplete data is reported as
// "unknown", never as a zero wait.

const fs = require("node:fs");

const MAX_PAGES = 10;
const DEFAULT_WARN_MINUTES = 20;
const REQUEST_TIMEOUT_MS = 15000;
const DEADLINE_MS = 30000;

function parseThreshold(raw) {
  const text = String(raw ?? "").trim();
  const value = Number(text);
  if (text !== "" && Number.isFinite(value) && value >= 0) return { minutes: value, valid: true };
  return { minutes: DEFAULT_WARN_MINUTES, valid: text === "" };
}

function minutesBetween(from, to) {
  const a = Date.parse(from);
  const b = Date.parse(to);
  if (!Number.isFinite(a) || !Number.isFinite(b) || b < a) return null;
  return (b - a) / 60000;
}

function fmt(minutes) {
  return minutes === null ? "unknown" : `${minutes.toFixed(1)} min`;
}

// A job that never got a runner reports started_at == created_at, which would
// print as a 0 wait. Say so instead.
function notStarted(job) {
  // No runner ever picked it up, whatever the conclusion (startup failure,
  // timed_out, cancelled, skipped): created_at == started_at there is not a wait.
  if (!job.runner_id && !job.runner_name) return true;
  if (["queued", "waiting", "pending", "requested"].includes(job.status)) return true;
  return job.conclusion === "skipped";
}

function analyzeJob(job, now) {
  const name = typeof job?.name === "string" && job.name ? job.name : "(unnamed job)";
  const runner = job?.runner_name || (Array.isArray(job?.labels) ? job.labels.join(",") : "") || "-";
  if (!job || typeof job !== "object") return { name, runner, state: "unknown", wait: null, run: null };
  if (notStarted(job)) return { name, runner, state: "not started", wait: null, run: null };
  const wait = minutesBetween(job.created_at, job.started_at);
  let run = null;
  let state = job.status === "completed" ? "completed" : "running";
  if (job.status === "completed") run = minutesBetween(job.started_at, job.completed_at);
  else if (job.status === "in_progress") run = minutesBetween(job.started_at, now);
  else state = "unknown";
  return { name, runner, state, wait, run };
}

function cell(text) {
  return String(text).replace(/\r?\n/g, " ").replace(/\|/g, "\\|");
}

function annotationEscape(text) {
  return String(text).replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
}

function render(rows, threshold, note) {
  const lines = ["### Runner queue wait", ""];
  if (note) lines.push(`> ${note}`, "");
  if (!rows.length && !note) lines.push("> No jobs returned for this run.", "");
  if (rows.length) {
    lines.push("| Job | Runner | State | Queued | Run time |", "| --- | --- | --- | ---: | ---: |");
    for (const r of rows) {
      const waited = r.state === "not started" ? "not started" : fmt(r.wait);
      const ran = r.state === "not started" ? "-" : fmt(r.run);
      lines.push(`| ${cell(r.name)} | ${cell(r.runner)} | ${r.state} | ${waited} | ${ran} |`);
    }
    lines.push("", `Warning threshold: ${threshold} min of queue wait. Wait is job created to job started.`);
  }
  return lines.join("\n") + "\n";
}

function warnings(rows, threshold) {
  return rows
    .filter((r) => r.wait !== null && r.wait > threshold)
    .map((r) => `::warning title=Long runner queue wait::${annotationEscape(`${r.name} waited ${r.wait.toFixed(1)} min for a runner (threshold ${threshold} min)${r.runner === "-" ? "" : `; runner ${r.runner}`}.`)}`);
}

// Bounds one request (headers and body). The abort signal stops a real fetch;
// the race also covers a fetch that ignores it. A hang must never outlive the
// step: the gate job is a required check with its own timeout.
async function withTimeout(ms, work) {
  const controller = new AbortController();
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error(`timed out after ${ms} ms`));
    }, ms);
  });
  try {
    return await Promise.race([work(controller.signal), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

// Returns { jobs } or { error }. A response that is malformed, or a list that
// cannot be shown complete, is an error: unknown, not "no jobs".
async function fetchJobs({ fetchImpl, apiUrl, repo, runId, token, timeoutMs = REQUEST_TIMEOUT_MS }) {
  const jobs = [];
  let total = null;
  for (let page = 1; page <= MAX_PAGES; page++) {
    let response;
    let body;
    try {
      ({ response, body } = await withTimeout(timeoutMs, async (signal) => {
        const res = await fetchImpl(`${apiUrl}/repos/${repo}/actions/runs/${runId}/jobs?per_page=100&page=${page}`, {
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
          },
          signal,
        });
        // Body read stays inside the timeout; a non-OK body is never parsed.
        return { response: res, body: res.ok ? await res.json().catch(() => undefined) : undefined };
      }));
    } catch (error) {
      return { error: `request failed (${error.message})` };
    }
    if (!response.ok) {
      const hint = response.status === 403 || response.status === 404 ? "; grant actions: read to the job's GITHUB_TOKEN" : "";
      return { error: `HTTP ${response.status}${hint}` };
    }
    if (body === undefined) return { error: "response was not valid JSON" };
    if (!body || !Array.isArray(body.jobs) || !Number.isInteger(body.total_count)) {
      return { error: "response was malformed" };
    }
    total = body.total_count;
    jobs.push(...body.jobs);
    if (jobs.length >= total) return { jobs };
    if (body.jobs.length === 0) break;
  }
  return { error: `job list incomplete (${jobs.length} of ${total})` };
}

// Composite steps have no timeout-minutes, so the limit lives here: a per-request
// timeout inside fetchJobs and one hard deadline over the whole report.
async function main(env = process.env, fetchImpl = globalThis.fetch, now = new Date().toISOString(), deadlineMs = DEADLINE_MS) {
  const { minutes: threshold, valid } = parseThreshold(env.WARN_AFTER_MINUTES);
  const out = [];
  let note = valid ? "" : `warn-after-minutes was not a non-negative number; using ${DEFAULT_WARN_MINUTES}.`;
  let rows = [];
  const { GITHUB_REPOSITORY: repo, GITHUB_RUN_ID: runId, GITHUB_TOKEN: token } = env;
  if (!repo || !runId || !token || typeof fetchImpl !== "function") {
    note = "Queue wait unknown: repository, run id, token or fetch was unavailable.";
  } else {
    const result = await withTimeout(deadlineMs, () => fetchJobs({
      fetchImpl,
      apiUrl: env.GITHUB_API_URL || "https://api.github.com",
      repo,
      runId,
      token,
    })).catch((error) => ({ error: `overall deadline exceeded (${error.message})` }));
    if (result.error) note = `Queue wait unknown: ${result.error}.${note ? " " + note : ""}`;
    else rows = result.jobs.map((job) => analyzeJob(job, now));
  }
  const summary = render(rows, threshold, note);
  if (env.GITHUB_STEP_SUMMARY) {
    try {
      fs.appendFileSync(env.GITHUB_STEP_SUMMARY, summary);
    } catch (error) {
      console.log(`could not write step summary: ${error.message}`);
      console.log(summary);
    }
  } else {
    console.log(summary);
  }
  for (const line of warnings(rows, threshold)) out.push(line);
  for (const line of out) console.log(line);
  return { rows, warnings: out, summary };
}

module.exports = { analyzeJob, fetchJobs, main, parseThreshold, render, warnings };

if (require.main === module) {
  main().catch((error) => console.log(`queue-wait skipped: ${error.message}`)).finally(() => process.exit(0));
}
