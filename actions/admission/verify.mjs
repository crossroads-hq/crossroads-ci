// Trusted remote-action entry. No consumer checkout, install, local action,
// scheduler credential, outputs, write endpoint or activation input.
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { HELD, pollAdmission } from '../../scripts/lib/ci-admission-native.mjs';
import { readNative } from './read.mjs';

// No live consumers or scheduler identity have been enrolled. Changing this
// requires a separately reviewed pinned source revision AFTER owner setup.
export const ENROLLMENTS = Object.freeze([]);
export async function runAction(phase, env = process.env) {
  const num = name => /^[1-9][0-9]*$/.test(env[name] || '') ? Number(env[name]) : NaN;
  const context = { repoId: num('GITHUB_REPOSITORY_ID'), runId: num('GITHUB_RUN_ID'),
    attempt: num('GITHUB_RUN_ATTEMPT'), jobKey: env.GITHUB_JOB, runnerName: env.RUNNER_NAME,
    sha: env.GITHUB_SHA, workflowSha: env.GITHUB_WORKFLOW_SHA, workflowRef: env.GITHUB_WORKFLOW_REF,
    eventName: env.GITHUB_EVENT_NAME };
  const matches = ENROLLMENTS.filter(e => e.repoId === context.repoId &&
    context.jobKey === (phase === 'launch' ? e.root.key : e.heavy.key));
  if (matches.length !== 1) return HELD; // before event read, network or token access
  try {
    const event = JSON.parse(await readFile(env.GITHUB_EVENT_PATH, 'utf8'));
    return await pollAdmission({ enrollment: matches[0], context, phase,
      now: Date.now, sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
      read: deadline => readNative({ enrollment: matches[0], context, event, token: env.GH_TOKEN, deadline }) });
  } catch { return HELD; }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = await runAction(process.argv[2]);
  if (result.status !== 'Verified') { console.error('Admission held'); process.exitCode = 1; }
}
