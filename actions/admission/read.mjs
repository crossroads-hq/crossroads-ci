// Dormant read-scoped GitHub adapter. Only trusted shipped code uses the token;
// no URL from an API payload or consumer input is requested.
import { createHash } from 'node:crypto';
import { validEnrollment } from '../../scripts/lib/ci-admission-native.mjs';

const ensure = b => { if (!b) throw new Error('Admission held'); };
const id = n => Number.isSafeInteger(n) && n > 0;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
export const closureDigest = files => hash(JSON.stringify(files.map(f => [f.path, f.sha256]).sort((a, b) => a[0].localeCompare(b[0], 'en'))));
export function githubReader({ token, deadline, now = Date.now, fetchImpl = fetch }) {
  return async path => {
    try {
      ensure(typeof token === 'string' && token.length > 0 && token.length < 4096 && !/[\r\n]/.test(token));
      ensure(typeof path === 'string' && /^\/(repositories\/\d+|repos\/crossroads-hq\/[a-z0-9-]+\/[^\s#]+)$/.test(path) &&
        !path.includes('..') && !path.includes('\\') && !/%(?:2e|2f|5c|0[0-9a-f]|1[0-9a-f]|7f)/i.test(path));
      const remaining = deadline - now(); ensure(Number.isFinite(remaining) && remaining > 0);
      const response = await fetchImpl(`https://api.github.com${path}`, { method: 'GET', redirect: 'error', cache: 'no-store',
        headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json',
          'x-github-api-version': '2022-11-28' }, signal: AbortSignal.timeout(Math.min(5000, remaining)) });
      ensure(response.status === 200 && response.body);
      const chunks = []; let size = 0;
      for await (const chunk of response.body) { size += chunk.length; ensure(size <= 1048576); chunks.push(chunk); }
      ensure(now() < deadline);
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      const link = response.headers.get('link');
      return { body, next: typeof link === 'string' && /rel="next"/.test(link) };
    } catch { throw new Error('Admission held'); }
  };
}
export async function collectPages(get, path, field) {
  const all = []; let total;
  for (let page = 1; page <= 10; page++) {
    const { body, next } = await get(`${path}${path.includes('?') ? '&' : '?'}per_page=100&page=${page}`);
    ensure(Number.isSafeInteger(body?.total_count) && body.total_count >= 0 && body.total_count <= 1000 &&
      Array.isArray(body[field]) && (total === undefined || total === body.total_count));
    total = body.total_count;
    ensure(body[field].length === Math.min(100, total - all.length));
    all.push(...body[field]);
    ensure(all.every(x => id(x?.id)) && new Set(all.map(x => x.id)).size === all.length);
    if (all.length === total) { ensure(next === false); return all; }
    ensure(next === true);
  }
  throw new Error('Admission held');
}
export async function readNative({ enrollment: e, context: c, event, token, deadline,
  now = Date.now, fetchImpl = fetch }) {
  try {
    ensure(validEnrollment(e) && c?.repoId === e.repoId && id(c.runId) && id(c.attempt) &&
      /^[a-f0-9]{40}$/.test(c.sha) && c.workflowSha === c.sha &&
      id(event?.pull_request?.number) && event.repository?.id === e.repoId &&
      typeof event.pull_request.base?.ref === 'string' &&
      /^[A-Za-z0-9_][A-Za-z0-9_./-]*$/.test(event.pull_request.base.ref) &&
      !event.pull_request.base.ref.includes('..') && !event.pull_request.base.ref.includes('//'));
    ensure(closureDigest(e.files) === e.digest);
    const readStartedAt = now(), get = githubReader({ token, deadline, now, fetchImpl });
    const repository = (await get(`/repositories/${e.repoId}`)).body;
    ensure(repository?.id === e.repoId && repository.full_name === e.repository);
    const base = `/repos/${e.repository}`, prNumber = event.pull_request.number;
    const body = async path => (await get(base + path)).body;
    const run = await body(`/actions/runs/${c.runId}`);
    const attempt = await body(`/actions/runs/${c.runId}/attempts/${c.attempt}`);
    const pr = await body(`/pulls/${prNumber}`);
    const baseRef = await body(`/git/ref/heads/${event.pull_request.base.ref.split('/').map(encodeURIComponent).join('/')}`);
    const merge = await body(`/git/ref/pull/${prNumber}/merge`);
    for (const file of e.files) {
      const content = await body(`/contents/${file.path}?ref=${c.workflowSha}`);
      ensure(content?.type === 'file' && content.path === file.path && content.encoding === 'base64' &&
        typeof content.content === 'string' && /^[A-Za-z0-9+/=\r\n]*$/.test(content.content) &&
        hash(Buffer.from(content.content, 'base64')) === file.sha256);
    }
    const items = await collectPages(get, `${base}/actions/runs/${c.runId}/attempts/${c.attempt}/jobs`, 'jobs');
    const jobs = { items, complete: true, observedAt: readStartedAt };
    const role = c.jobKey === e.root.key ? e.root : c.jobKey === e.heavy.key ? e.heavy : null;
    ensure(role);
    const matches = items.filter(j => j.name === role.name); ensure(matches.length === 1 && id(matches[0].id));
    const actualJob = await body(`/actions/jobs/${matches[0].id}`);
    const checkMatch = new RegExp(`^https://api\\.github\\.com/repos/${e.repository}/check-runs/([1-9][0-9]*)$`).exec(actualJob?.check_run_url);
    ensure(checkMatch && id(Number(checkMatch[1])));
    const jobCheck = await body(`/check-runs/${checkMatch[1]}`);
    const checks = { items: await collectPages(get, `${base}/commits/${c.sha}/check-runs?filter=all`, 'check_runs'),
      complete: true, observedAt: readStartedAt };
    // Re-fetch mutable identity/ref anchors so a concurrent move or new attempt
    // cannot hide behind a successful earlier page. Unknown remains a hold.
    for (const [path, previous] of [[`/actions/runs/${c.runId}`, run], [`/pulls/${prNumber}`, pr],
      [`/git/ref/heads/${event.pull_request.base.ref.split('/').map(encodeURIComponent).join('/')}`, baseRef],
      [`/git/ref/pull/${prNumber}/merge`, merge]]) {
      const current = await body(path);
      // Compare authoritative identity fields, not unrelated counters/timestamps.
      const anchor = value => path.startsWith('/pulls/') ? [value?.number, value?.state, value?.draft,
        value?.head?.sha, value?.head?.repo?.id, value?.base?.ref, value?.base?.sha, value?.base?.repo?.id, value?.merge_commit_sha] :
        path.startsWith('/actions/') ? [value?.id, value?.run_attempt, value?.status, value?.head_sha, value?.workflow_id,
          value?.repository?.id, value?.head_repository?.id, value?.pull_requests] : [value?.ref, value?.object?.sha];
      ensure(JSON.stringify(anchor(current)) === JSON.stringify(anchor(previous)));
    }
    const repositoryAgain = (await get(`/repositories/${e.repoId}`)).body;
    ensure(repositoryAgain?.id === e.repoId && repositoryAgain.full_name === e.repository);
    return { repository, event, run, attempt, pr, base: baseRef, merge, jobs, checks, actualJob, jobCheck,
      workflowDigest: e.digest, readStartedAt, readCompletedAt: now() };
  } catch { return null; }
}
