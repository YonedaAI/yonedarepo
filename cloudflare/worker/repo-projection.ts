// Projects landed branch refs into the repository's object store, so `git clone` of the
// Artifacts repository shows exactly what the authority landed. Each push carries the
// last projected value as an expected-old lease; a refusal is recorded as drift and
// left for the owner, never forced.
import { compute } from './repo-compute';
import { fromBase64, parseStore, RepoObjects, toBase64 } from './repo-objects';
import { caller } from './repo-ops';
import type { Env, Envelope } from './types';

export async function dispatchProjection(env: Env, repo: string) {
  await env.PLATFORM_QUEUE.send({ v: 1, kind: 'platform_project', repo_id: repo, job_id: 'refs' });
}

/** Pushes every pending ref target; throws (for queue retry) only on transport failure. */
export async function projectRefs(env: Env, envelope: Envelope) {
  const call = caller(env, envelope.repo_id, { _system: 'projection' });
  const { pending } = await call({ op: 'repo_projection_pending' });
  if (pending.length === 0) return { projected: 0 };
  const status = await call({ op: 'repo_status' });
  const objects = new RepoObjects(env, envelope.repo_id, parseStore(env, status.object_store));
  let projected = 0;
  for (const row of pending) {
    const { push_b64 } = compute({
      op: 'ref_update',
      refname: row.refname,
      old: row.projected_commit ?? null,
      new: row.target_commit,
    });
    const report = await objects.push(fromBase64(push_b64));
    const outcome = compute({
      op: 'push_outcome',
      refname: row.refname,
      report_b64: toBase64(report),
    });
    await call({
      op: 'repo_projection_result',
      refname: row.refname,
      version: row.target_version,
      ...(outcome.accepted
        ? { outcome: 'ok', commit: row.target_commit }
        : { outcome: 'drift', detail: `Object store refused the update: ${outcome.refused}` }),
    });
    if (outcome.accepted) projected++;
  }
  return { projected };
}
