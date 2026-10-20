// Projects the authority into its object stores. Staged commits (accepted once the
// authority held their objects) are written to R2, the store of record, and the staged
// copies dropped. Protected branch refs are projected to Artifacts so `git clone` shows
// exactly what landed: one receive-pack carries every object Artifacts lacks plus the ref
// update, with the last projected value as an expected-old lease; a refusal is recorded
// as drift and left for the owner, never forced.
import { compute } from './repo-compute';
import { fromBase64, parseStore, RepoObjects, toBase64 } from './repo-objects';
import { caller, type Json } from './repo-ops';
import { putRaw } from './repo-stores';
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

// Rounds of up to 64 commits per invocation: each object write is a subrequest, and a
// Worker invocation has a bounded number.
const OUTBOX_ROUNDS = 2;

/** Writes one staged commit's objects to the store of record; each write is confirmed. */
async function projectCommit(objects: RepoObjects, entry: Json) {
  try {
    await putRaw(objects.env, (id) => objects.rawKey(id), entry.objects);
    return { commit: entry.commit, outcome: 'ok' };
  } catch (e: any) {
    const detail = `${e?.code ?? 'ERROR'}: ${String(e?.message ?? e).slice(0, 300)}`;
    return { commit: entry.commit, outcome: 'failed', detail };
  }
}

/**
 * Drains the object outbox into R2, and the authority drops its staged copies only for
 * commits whose every object write was confirmed. Idempotent under duplicate delivery;
 * throws (for queue retry) while a commit fails, and hands a long outbox to a fresh job.
 */
export async function projectObjects(env: Env, repo: string) {
  const call = caller(env, repo, { _system: 'projection' });
  let objects: RepoObjects | undefined;
  let projected = 0;
  for (let round = 0; round < OUTBOX_ROUNDS; round++) {
    const { commits } = await call({ op: 'repo_objects_pending' });
    if (commits.length === 0) return { projected, more: false };
    if (!objects) {
      const status = await call({ op: 'repo_status' });
      objects = new RepoObjects(env, repo, parseStore(env, status.object_store));
    }
    const store = objects;
    const results = await Promise.all((commits as Json[]).map((e) => projectCommit(store, e)));
    await call({ op: 'repo_objects_projected', results });
    const failed = results.filter((r) => r.outcome !== 'ok');
    if (failed.length > 0) throw new Error(`${failed.length} staged commits are not in R2 yet`);
    projected += results.length;
  }
  await dispatchObjects(env, repo);
  return { projected, more: true };
}

// Objects per receive-pack: reading each from R2 is a subrequest.
const PACK_OBJECTS = 400;

/** Pushes `commits` (oldest first) each under its own hidden ref, for a projection too
 * large for one pack, and records them as held by Artifacts once read back. */
async function storeAhead(call: (c: Json) => Promise<Json>, objects: RepoObjects, commits: Json[]) {
  const raw = await objects.raw(commits.flatMap((c) => c.objects));
  const byId = new Map(raw.map((o) => [o.id, o]));
  await Promise.all(
    commits.map(async (c) => {
      const own = (c.objects as Json[]).map((o) => byId.get(o.id));
      if (own.some((o) => !o)) throw new Error(`Objects of ${c.commit} are not readable`);
      const built = compute({ op: 'staged_push', commit: c.commit, objects: own });
      await objects.pushCommit(fromBase64(built.push_b64), c.commit);
    }),
  );
  await call({ op: 'repo_objects_stored', commits: commits.map((c) => c.commit) });
}

/** Commits from the front of `commits` holding at least `limit` objects. */
function front(commits: Json[], limit: number) {
  let count = 0;
  let n = 0;
  while (n < commits.length && count < limit) count += commits[n++].objects.length;
  return n;
}

/**
 * Projects every pending protected ref: its new objects and the ref update in one
 * receive-pack. Throws (for queue retry) only on transport failure or unreadable objects.
 */
export async function projectRefs(env: Env, envelope: Envelope) {
  const call = caller(env, envelope.repo_id, { _system: 'projection' });
  const { pending } = await call({ op: 'repo_projection_pending' });
  if (pending.length === 0) return { projected: 0 };
  const status = await call({ op: 'repo_status' });
  const objects = new RepoObjects(env, envelope.repo_id, parseStore(env, status.object_store));
  let projected = 0;
  for (const row of pending) {
    const plan = await call({ op: 'repo_projection_objects', refname: row.refname });
    let commits = plan.commits as Json[];
    while (commits.reduce((n, c) => n + c.objects.length, 0) > PACK_OBJECTS) {
      const n = front(commits, PACK_OBJECTS);
      await storeAhead(call, objects, commits.slice(0, n));
      commits = commits.slice(n);
    }
    const wanted = commits.flatMap((c) => c.objects);
    const raw = await objects.raw(wanted);
    if (raw.length < wanted.length) throw new Error(`Objects for ${row.refname} are not readable`);
    const { push_b64 } = compute({
      op: 'branch_push',
      refname: row.refname,
      old: row.projected_commit ?? null,
      new: row.target_commit,
      objects: raw,
    });
    const report = await objects.push(fromBase64(push_b64));
    const outcome = compute({
      op: 'push_outcome',
      refname: row.refname,
      report_b64: toBase64(report),
    });
    if (outcome.accepted) {
      // Verified like a commit push: the store itself must serve the target as recorded.
      const [readback, recorded] = await Promise.all([
        objects.store.readCommit(row.target_commit),
        call({ op: 'repo_commit', commit: row.target_commit, brief: true }),
      ]);
      if (readback?.tree !== recorded.tree)
        throw new Error(`${row.refname} target is not readable from the object store`);
    }
    await call({
      op: 'repo_projection_result',
      refname: row.refname,
      version: row.target_version,
      ...(outcome.accepted
        ? { outcome: 'ok', commit: row.target_commit, commits: commits.map((c) => c.commit) }
        : { outcome: 'drift', detail: `Object store refused the update: ${outcome.refused}` }),
    });
    if (outcome.accepted) projected++;
  }
  return { projected };
}
