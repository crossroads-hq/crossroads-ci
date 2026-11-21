// Native evidence decoder and bounded reader protocol. No execution authority,
// credentials, I/O or ambient clock here. Synthetic callers are NOT enrollment.
import { APPROVED, CANDIDATES, inputKey, executionKey, observeList, permitDecision,
  JOB_STATUSES, JOB_CONCLUSIONS } from './ci-admission.mjs';

export const HELD = Object.freeze({ status: 'Held', reason: 'Admission held' });
const WAITING = Object.freeze({ status: 'Waiting', reason: 'Admission held' });
const id = n => Number.isSafeInteger(n) && n > 0;
const clock = n => Number.isSafeInteger(n) && n >= 0 && n <= 8640000000000000;
const hex = (s, n) => typeof s === 'string' && new RegExp(`^[a-f0-9]{${n}}$`).test(s);
const ensure = b => { if (!b) throw new Error('Admission held'); };
const fresh = (at, now) => clock(at) && clock(now) && at <= now && now - at <= CANDIDATES.evidenceMs;
export const validPath = s => typeof s === 'string' && s.length <= 256 &&
  s.split('/').every((p, n) => (n === 0 && p === '.github') ||
    (/^[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(p) && !p.endsWith('.lock') && !p.includes('..')));
const ref = s => typeof s === 'string' && s.length > 0 && s.length <= 256 && s.split('/').every(p =>
  /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(p) && !p.includes('..') && !p.endsWith('.') && !p.endsWith('.lock'));
const jobName = s => typeof s === 'string' && /^[A-Za-z0-9 _/-]{1,100}$/.test(s);
export function validEnrollment(e) {
  return e && APPROVED.repoIds.includes(e.repoId) && /^crossroads-hq\/[a-z0-9-]+$/.test(e.repository) &&
    id(e.workflowId) && id(e.schedulerAppId) && e.schedulerAppId !== APPROVED.gateAppId &&
    /^\.github\/workflows\/[a-zA-Z0-9_-]+\.ya?ml$/.test(e.workflow) && hex(e.digest, 64) &&
    [e.root, e.heavy].every(j => j && /^[a-zA-Z_][a-zA-Z0-9_-]{0,63}$/.test(j.key) && jobName(j.name)) &&
    e.root.key !== e.heavy.key && e.root.name !== e.heavy.name &&
    ['Validate', 'Verify', 'Storybook', 'AI'].includes(e.workload) && e.capability === 'fast' &&
    Array.isArray(e.files) && e.files.length > 0 && e.files.length <= 32 &&
    e.files.every(f => (validPath(f.path) || f.path === e.workflow) && hex(f.sha256, 64)) &&
    new Set(e.files.map(f => f.path)).size === e.files.length && e.files.some(f => f.path === e.workflow);
}
const closedJob = j => j && id(j.id) && id(j.run_id) && id(j.run_attempt) && hex(j.head_sha, 40) &&
  typeof j.name === 'string' && JOB_STATUSES.includes(j.status) &&
  (j.status === 'completed' ? JOB_CONCLUSIONS.includes(j.conclusion) : j.conclusion === null);
function original(pr, repoId) {
  ensure(pr && id(pr.number) && pr.head?.repo?.id === repoId && pr.base?.repo?.id === repoId &&
    hex(pr.head.sha, 40) && hex(pr.base.sha, 40) && hex(pr.merge_commit_sha, 40) && ref(pr.base.ref));
  return { repoId, pr: pr.number, head: pr.head.sha, baseRef: pr.base.ref,
    baseSha: pr.base.sha, mergeSha: pr.merge_commit_sha };
}
function nativeRun(run, c, e, i) {
  const ps = run?.pull_requests;
  return run && run.id === c.runId && run.run_attempt === c.attempt && run.event === 'pull_request' &&
    run.status === 'in_progress' && run.conclusion === null && run.repository?.id === e.repoId &&
    run.head_repository?.id === e.repoId && run.workflow_id === e.workflowId && run.path === e.workflow &&
    run.head_sha === i.head && Array.isArray(ps) && ps.length === 1 && ps[0].number === i.pr &&
    ps[0].head?.sha === i.head && ps[0].base?.sha === i.baseSha && ps[0].base?.ref === i.baseRef &&
    ps[0].head?.repo?.id === e.repoId && ps[0].base?.repo?.id === e.repoId;
}
function decodeCheck(check, e, input) {
  ensure(check.app?.id === e.schedulerAppId && check.head_sha === input.mergeSha &&
    typeof check.output?.text === 'string' && check.output.text.length <= 16000);
  const p = JSON.parse(check.output.text);
  ensure(p.protocol === 'hq-085-permit-v1' && inputKey(p.input) && executionKey(p.execution) &&
    p.input.repoId === e.repoId && p.execution.repoId === e.repoId &&
    p.id === check.id && p.appId === check.app.id && p.status === check.status && p.conclusion === check.conclusion &&
    ['launch', 'checkout'].includes(p.phase) && check.name === `CI admission ${p.phase} / ${e.workload}` &&
    check.external_id === `hq-085/v1/${p.execution.generation}/${p.phase}` &&
    clock(p.launchIssuedAt) && clock(p.issuedAt) && clock(p.expiresAt) && p.issuedAt >= p.launchIssuedAt &&
    p.expiresAt === p.issuedAt + CANDIDATES.permitMs &&
    (p.phase === 'launch' ? p.execution.heavyJobId === null && p.issuedAt === p.launchIssuedAt :
      id(p.execution.heavyJobId) && p.issuedAt < p.launchIssuedAt + CANDIDATES.permitMs));
  return p;
}
export function nativeDecision(s, e, c, phase, now) {
  try {
    ensure(validEnrollment(e) && c && ['repoId', 'runId', 'attempt'].every(k => id(c[k])) &&
      c.repoId === e.repoId && ['launch', 'checkout'].includes(phase) && c.eventName === 'pull_request' &&
      c.jobKey === (phase === 'launch' ? e.root.key : e.heavy.key) &&
      typeof c.runnerName === 'string' && c.runnerName.length > 0 && c.runnerName.length <= 256);
    ensure(s && fresh(s.readStartedAt, now) && clock(s.readCompletedAt) &&
      s.readCompletedAt >= s.readStartedAt && s.readCompletedAt <= now &&
      s.repository?.id === e.repoId && s.repository.full_name === e.repository && s.event?.repository?.id === e.repoId);
    const i = { ...original(s.event.pull_request, e.repoId), workflow: e.workflow, digest: e.digest,
      workload: e.workload, capability: e.capability };
    ensure(inputKey(i) && s.event.pull_request.draft === false && s.event.pull_request.state === 'open' &&
      s.pr?.draft === false && s.pr.state === 'open' && inputKey({ ...i, ...original(s.pr, e.repoId) }) === inputKey(i) &&
      s.base?.ref === `refs/heads/${i.baseRef}` && s.base.object?.sha === i.baseSha &&
      s.merge?.ref === `refs/pull/${i.pr}/merge` && s.merge.object?.sha === i.mergeSha &&
      c.sha === i.mergeSha && c.workflowSha === i.mergeSha &&
      c.workflowRef === `${e.repository}/${e.workflow}@refs/pull/${i.pr}/merge` &&
      s.workflowDigest === e.digest && nativeRun(s.run, c, e, i) && nativeRun(s.attempt, c, e, i));
    const jobs = observeList(s.jobs, now, closedJob), checks = observeList(s.checks, now, check =>
      check && typeof check.name === 'string' && id(check.app?.id) && hex(check.head_sha, 40) &&
      JOB_STATUSES.includes(check.status) && (check.status === 'completed' ? JOB_CONCLUSIONS.includes(check.conclusion) : check.conclusion === null));
    ensure(jobs.status === 'Known' && checks.status === 'Known' &&
      s.jobs.observedAt === s.readStartedAt && s.checks.observedAt === s.readStartedAt &&
      jobs.items.every(j => j.run_id === c.runId && j.run_attempt === c.attempt && j.head_sha === i.head));
    const name = phase === 'launch' ? e.root.name : e.heavy.name;
    const actual = jobs.items.filter(j => j.name === name);
    ensure(actual.length === 1);
    const j = actual[0], native = s.jobCheck;
    ensure(j.status === 'in_progress' && j.runner_name === c.runnerName && id(j.runner_id) &&
      ['id', 'run_id', 'run_attempt', 'head_sha', 'name', 'status', 'conclusion', 'runner_id', 'runner_name', 'check_run_url']
        .every(k => s.actualJob?.[k] === j[k]) && id(native?.id) && native.app?.id === APPROVED.gateAppId &&
      native.head_sha === i.head && native.status === 'in_progress' && native.conclusion === null &&
      j.check_run_url === `https://api.github.com/repos/${e.repository}/check-runs/${native.id}` &&
      native.details_url === `https://github.com/${e.repository}/actions/runs/${c.runId}/job/${j.id}`);
    // Decode ALL permit-named checks before scoping: malformed or conflicting
    // evidence must not disappear behind a favorable candidate filter.
    const permits = checks.items.filter(k => k.name === `CI admission launch / ${e.workload}` ||
      k.name === `CI admission checkout / ${e.workload}`).map(k => decodeCheck(k, e, i));
    const current = permits.filter(p => p.execution.repoId === e.repoId && p.execution.runId === c.runId &&
      p.execution.attempt === c.attempt);
    ensure(permits.every(p => p.issuedAt <= now) && current.every(p => inputKey(p.input) === inputKey(i)) &&
      new Set(current.map(p => p.execution.generation)).size <= 1 &&
      new Set(current.map(p => p.execution.rootJobId)).size <= 1 &&
      new Set(current.map(p => p.launchIssuedAt)).size <= 1 &&
      new Set(current.map(p => p.phase)).size === current.length);
    const candidates = current.filter(p => p.phase === phase);
    if (!candidates.length) return WAITING;
    ensure(candidates.length === 1);
    const p = candidates[0], x = p.execution;
    const roots = jobs.items.filter(job => job.name === e.root.name);
    ensure(roots.length === 1 && roots[0].id === x.rootJobId &&
      (phase === 'launch' ? x.rootJobId === j.id && x.heavyJobId === null :
        x.heavyJobId === j.id && roots[0].status === 'completed' && roots[0].conclusion === 'success'));
    if (p.status === 'queued' || p.status === 'in_progress') return WAITING;
    ensure(permitDecision({ items: [p], complete: true, observedAt: s.readStartedAt }, {
      input: i, execution: x, phase, appId: e.schedulerAppId, checkId: p.id,
      launchIssuedAt: p.launchIssuedAt }, now).status === 'Verified');
    return { status: 'Verified', reason: 'Exact live permit', checkId: p.id, execution: x };
  } catch { return HELD; }
}

// The entire observation is reacquired on every poll, including actual job and
// current refs. No cached root output, partial page, or stale success is reused.
export async function pollAdmission({ enrollment, context, phase, read, now, sleep }) {
  const started = now(), deadline = started + 30000;
  let last = started;
  for (let n = 0; n < 6; n++) {
    try {
      const at = now(); ensure(clock(at) && at >= last && at < deadline); last = at;
      const sample = await read(deadline), completed = now();
      ensure(clock(completed) && completed >= last && completed < deadline); last = completed;
      const result = nativeDecision(sample, enrollment, context, phase, completed);
      if (result.status !== 'Waiting') return result;
      await sleep(Math.min(CANDIDATES.launchPollMs, deadline - completed));
    } catch { return HELD; }
  }
  return HELD;
}
