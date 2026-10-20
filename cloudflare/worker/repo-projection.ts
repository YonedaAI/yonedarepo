// Projects the authority into the repository's object store. Staged commits (accepted
// once the authority held their objects) are pushed to their hidden refs and read back;
// landed branch refs follow, so `git clone` of the Artifacts repository shows exactly what
// the authority landed. Each ref push carries the last projected value as an
// expected-old lease; a refusal is recorded as drift and left for the owner, never forced.
import { compute } from './repo-compute';
import { type CachedObject, fromBase64, parseStore, RepoObjects, toBase64 } from './repo-objects';
import { caller, type Json } from './repo-ops';
import type { Env, Envelope } from './types';

export async function dispatchProjection(env: Env, repo: string) {
  await env.PLATFORM_QUEUE.send({ v: 1, kind: 'platform_project', repo_id: repo, job_id: 'refs' });
}

export async function dispatchObjects(env: Env, repo: string) {
  await env.PLATFORM_QUEUE.send({
    v: 1,
    kind: 'platform_objects',
    repo_id: repo,
    job_id: 'objects',
  });
}

const OUTBOX_ROUNDS = 16;

/** Pushes one staged commit (its objects fill the R2 tier alongside) and reads it back. */
async function projectCommit(objects: RepoObjects, entry: Json) {
  try {
    const built = compute({ op: 'staged_push', commit: entry.commit, objects: entry.objects });
    const cached = objects.cache(built.objects as CachedObject[]);
    const { readback } = await objects.pushCommit(fromBase64(built.push_b64), entry.commit, cached);
    if (
      readback.tree !== built.tree ||
      JSON.stringify(readback.parents) !== JSON.stringify(built.parents)
    )
      return { commit: entry.commit, outcome: 'failed', detail: 'Object store readback differs' };
    return { commit: entry.commit, outcome: 'ok' };
  } catch (e: any) {
    const detail = `${e?.code ?? 'ERROR'}: ${String(e?.message ?? e).slice(0, 300)}`;
    return { commit: entry.commit, outcome: 'failed', detail };
  }
}

/**
 * Drains the object outbox: every staged commit is pushed (together, so the store's push
 * queue combines them into one receive-pack) and read back, and the authority drops its
 * staged copies only for verified ones. Idempotent under duplicate delivery; throws (for
 * queue retry) while anything stays pending.
 */
export async function projectObjects(env: Env, repo: string) {
  const call = caller(env, repo, { _system: 'projection' });
  let objects: RepoObjects | undefined;
  let projected = 0;
  for (let round = 0; round < OUTBOX_ROUNDS; round++) {
    const { commits } = await call({ op: 'repo_objects_pending' });
    if (commits.length === 0) return { projected };
    if (!objects) {
      const status = await call({ op: 'repo_status' });
      objects = new RepoObjects(env, repo, parseStore(env, status.object_store));
    }
    const store = objects;
    const results = await Promise.all((commits as Json[]).map((e) => projectCommit(store, e)));
    await call({ op: 'repo_objects_projected', results });
    const failed = results.filter((r) => r.outcome !== 'ok');
    if (failed.length > 0)
      throw new Error(`${failed.length} staged commits are not in the object store yet`);
    projected += results.length;
  }
  throw new Error('The object outbox did not drain');
}

/** Pushes every pending ref target; throws (for queue retry) only on transport failure. */
export async function projectRefs(env: Env, envelope: Envelope) {
  const call = caller(env, envelope.repo_id, { _system: 'projection' });
  const { pending, objects_pending } = await call({ op: 'repo_projection_pending' });
  if (pending.length === 0) return { projected: 0 };
  // A ref to objects the store lacks would be refused (and misread as drift).
  if (objects_pending > 0) await projectObjects(env, envelope.repo_id);
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
