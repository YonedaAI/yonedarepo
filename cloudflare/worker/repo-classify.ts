// Review classes for pushed commits. A server-side commit is classified as it is built; a push
// is not, so Git never waits on it: the push queues its new commits and this job classifies them
// from the touches the authority recorded. Until it has, and for anything it skips, the commit
// is unclassified and needs a human, so losing a job or reading past a budget is safe.
import { reviewClasses } from './repo-code';
import { caller, type Json, RepoContext } from './repo-ops';
import type { Env, Envelope } from './types';

export const CLASSIFY = 'platform_classify';
/** Commits of one push classified (classes.rs PENDING_COMMITS); a longer push is left alone. */
export const CLASSIFY_COMMITS = 32;
/** Changed files one job reads, both sides of each: at most what one server-side commit may. */
const CLASSIFY_FILES = 200;
/** File bytes one commit supplies to compute: Wasm memory never shrinks once grown. */
const CLASSIFY_BYTES = 8 * 1024 * 1024;

export async function queueClassify(env: Env, repo: string, commits: string[]) {
  if (commits.length === 0 || commits.length > CLASSIFY_COMMITS) return;
  await env.PLATFORM_QUEUE.send({ v: 1, kind: CLASSIFY, repo_id: repo, job_id: 'push', commits });
}

/** The queue job, parents first: an ancestor left out would keep its descendants unproved, so
 * the file budget simply ends the job. Failures settle here: the commit stays unclassified. */
export async function classifyJob(env: Env, envelope: Envelope) {
  const repo = envelope.repo_id;
  const call = caller(env, repo, { _system: 'derive' });
  const ctx = new RepoContext(env, repo, call);
  try {
    const { pending } = await call({ op: 'repo_classes_pending', commits: envelope.commits });
    let files = 0;
    for (const { commit, touches } of pending as Json[]) {
      files += touches.length;
      if (files > CLASSIFY_FILES) return;
      const classes = await reviewClasses(ctx, commit, touches, [], CLASSIFY_BYTES).catch(
        () => null,
      );
      if (classes) await call(classes);
    }
  } catch (e) {
    console.warn(`classify job settled: ${String((e as Error)?.message ?? e).slice(0, 200)}`);
  }
}
