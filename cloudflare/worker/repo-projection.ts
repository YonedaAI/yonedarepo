// Projects the authority into its object stores. Staged commits (accepted once the
// authority held their objects) are written to R2, the store of record, and the staged
// copies dropped. Protected branch refs are projected to Artifacts so `git clone` shows
// exactly what landed: one receive-pack carries every object Artifacts lacks plus the ref
// update, with the last projected value as an expected-old lease; a refusal is recorded
// as drift and left for the owner, never forced.
import { noteBundles, type Wanted } from './repo-bundles';
import { compute } from './repo-compute';
import { fromBase64, parseStore, RepoObjects, toBase64 } from './repo-objects';
import { caller, type Json } from './repo-ops';
import { shardCall } from './repo-shards';
import { putRaw } from './repo-stores';
import type { Env, Envelope } from './types';

export async function dispatchProjection(env: Env, repo: string) {
  await env.PLATFORM_QUEUE.send({ v: 1, kind: 'platform_project', repo_id: repo, job_id: 'refs' });
}

/** Asks for a drain of the authority's object outbox, or of commit shard `shard`'s. */
export async function dispatchObjects(env: Env, repo: string, shard?: number) {
  await env.PLATFORM_QUEUE.send({
    v: 1,
    kind: 'platform_objects',
    repo_id: repo,
    job_id: shard === undefined ? 'objects' : `shard:${shard}`,
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
export async function projectObjects(env: Env, repo: string, job = 'objects') {
  const shard = /^shard:(\d+)$/.exec(job);
  const authority = caller(env, repo, { _system: 'projection' });
  const call = shard
    ? (c: Json) =>
        shardCall(env, repo, Number(shard[1]), { ...c, op: c.op.replace(/^repo_/, 'store_') })
    : authority;
  let objects: RepoObjects | undefined;
  let projected = 0;
  for (let round = 0; round < OUTBOX_ROUNDS; round++) {
    const { commits } = await call({ op: 'repo_objects_pending' });
    if (commits.length === 0) return { projected, more: false };
    if (!objects) {
      const status = await authority({ op: 'repo_status' });
      objects = new RepoObjects(env, repo, parseStore(env, status.object_store));
    }
    const store = objects;
    const results = await Promise.all((commits as Json[]).map((e) => projectCommit(store, e)));
    await call({ op: 'repo_objects_projected', results });
    const failed = results.filter((r) => r.outcome !== 'ok');
    if (failed.length > 0) throw new Error(`${failed.length} staged commits are not in R2 yet`);
    projected += results.length;
  }
  await dispatchObjects(env, repo, shard ? Number(shard[1]) : undefined);
  return { projected, more: true };
}

// Objects per receive-pack: reading each from R2 is a subrequest.
const PACK_OBJECTS = 400;
/** File bytes one carrier pack holds at most (every one is in memory while it is built). */
const CARRIER_BYTES = 32 * 1024 * 1024;
/** Files read from the tiers at a time while carriers fill. */
const CARRIER_READS = 64;

/**
 * Pushes `commits` (oldest first), each under its own hidden ref, in ONE receive-pack, for
 * a projection too large for one pack, and records them as held by Artifacts once each is
 * read back. (Separate pushes could land a child before its parent and be refused.) A
 * single commit too large for one pack sends its files ahead in carriers.
 */
async function storeAhead(call: (c: Json) => Promise<Json>, objects: RepoObjects, commits: Json[]) {
  const huge = commits.length === 1 && commits[0].objects.length > PACK_OBJECTS;
  const { carriers, carried } = huge
    ? await carryFiles(objects, commits[0])
    : { carriers: [] as string[], carried: new Set<string>() };
  const own = (c: Json) => (c.objects as Json[]).filter((o) => !carried.has(o.id));
  const raw = await objects.raw(commits.flatMap(own) as Wanted[], owners(commits));
  const byId = new Map(raw.map((o) => [o.id, o]));
  const bodies = commits.map((c) => {
    const read = own(c).map((o) => byId.get(o.id));
    if (read.some((o) => !o)) throw new Error(`Objects of ${c.commit} are not readable`);
    return compute({ op: 'staged_push', commit: c.commit, objects: read }).push_b64;
  });
  await objects.push(fromBase64(combine(bodies)));
  const readback = await Promise.all(commits.map((c) => objects.store.readCommit(c.commit)));
  const missing = commits.filter((_, i) => !readback[i]);
  if (missing.length > 0)
    throw new Error(`${missing.length} commits are not readable from the object store`);
  await call({ op: 'repo_objects_stored', commits: commits.map((c) => c.commit) });
  if (carriers.length > 0) await dropCarriers(objects, carriers);
}

const combine = (bodies: string[]) =>
  bodies.length === 1 ? bodies[0] : compute({ op: 'push_combine', bodies_b64: bodies }).push_b64;

/**
 * Sends `commit`'s files ahead of it in packs of at most PACK_OBJECTS files and about
 * CARRIER_BYTES (`carrier_push`: each under a carrier's hidden ref, read back), so no pack,
 * and no read held for one, grows with the commit; its trees and itself follow in one
 * more. A retried job repeats the same carriers.
 */
async function carryFiles(objects: RepoObjects, commit: Json) {
  const files = (commit.objects as Wanted[]).filter((o) => o.kind === 'blob');
  const carriers: string[] = [];
  const carried = new Set<string>();
  let chunk: Json[] = [];
  let bytes = 0;
  const send = async () => {
    if (chunk.length === 0) return;
    const pushed = compute({ op: 'carrier_push', objects: chunk });
    chunk = [];
    bytes = 0;
    await objects.push(fromBase64(pushed.push_b64));
    if (!(await objects.store.readCommit(pushed.commit)))
      throw new Error(`Files of ${commit.commit} are not readable from the object store`);
    carriers.push(pushed.commit);
  };
  for (let i = 0; i < files.length; i += CARRIER_READS) {
    const wave = files.slice(i, i + CARRIER_READS);
    const raw = await objects.raw(wave, owners([commit]));
    if (raw.length < new Set(wave.map((o) => o.id)).size)
      throw new Error(`Objects of ${commit.commit} are not readable`);
    for (const object of raw) {
      chunk.push(object);
      carried.add(object.id);
      bytes += (object.data_b64.length * 3) / 4;
      if (chunk.length >= PACK_OBJECTS || bytes >= CARRIER_BYTES) await send();
    }
  }
  await send();
  return { carriers, carried };
}

/** Deletes carrier refs once the commit holding their files is stored (best effort: a
 * carrier left behind only keeps files the commit keeps anyway). */
async function dropCarriers(objects: RepoObjects, carriers: string[]) {
  const bodies = carriers.map((commit) => compute({ op: 'ref_delete', commit }).push_b64);
  await objects
    .push(fromBase64(combine(bodies)))
    .catch((e) => console.warn(`carrier refs not deleted: ${e?.message ?? e}`));
}

/** The commit each planned object came with: a staged one is in that commit's shard. */
const owners = (commits: Json[]) =>
  new Map<string, string>(
    commits.flatMap((c) => (c.objects as Json[]).map((o) => [o.id, c.commit] as [string, string])),
  );

/** Commits from the front of `commits` holding at least `limit` objects. */
function front(commits: Json[], limit: number) {
  let count = 0;
  let n = 0;
  while (n < commits.length && count < limit) count += commits[n++].objects.length;
  return n;
}

/**
 * A refused ref update is retried for this many job attempts before it is recorded as
 * drift: a concurrent projection of the same ref that moved it first (and has not reported
 * yet) refuses a stale expected-old exactly as a foreign write does, and the retry plans
 * again from what that projection reported.
 */
const REFUSED_ATTEMPTS = 3;

/**
 * Projects every pending protected ref: its new objects and the ref update in one
 * receive-pack. Throws (for queue retry) only on transport failure or unreadable objects;
 * asks for a delayed retry (`retry`, seconds) while a refusal may still be a race.
 */
export async function projectRefs(env: Env, envelope: Envelope, attempt = REFUSED_ATTEMPTS) {
  const call = caller(env, envelope.repo_id, { _system: 'projection' });
  const { pending } = await call({ op: 'repo_projection_pending' });
  if (pending.length === 0) return { projected: 0 };
  const status = await call({ op: 'repo_status' });
  // A repository with bundles has its objects located in bulk, not one staged read per 64.
  if (status.bundled) noteBundles(envelope.repo_id);
  const objects = new RepoObjects(env, envelope.repo_id, parseStore(env, status.object_store));
  let projected = 0;
  let retry = 0;
  for (const row of pending) {
    const plan = await call({ op: 'repo_projection_objects', refname: row.refname });
    let commits = plan.commits as Json[];
    while (commits.reduce((n, c) => n + c.objects.length, 0) > PACK_OBJECTS) {
      const n = front(commits, PACK_OBJECTS);
      await storeAhead(call, objects, commits.slice(0, n));
      commits = commits.slice(n);
    }
    const wanted = commits.flatMap((c) => c.objects);
    const raw = await objects.raw(wanted, owners(commits));
    // `raw` answers each object once; commits may share one (a batch's tree is its change's).
    if (raw.length < new Set(wanted.map((o) => o.id)).size)
      throw new Error(`Objects for ${row.refname} are not readable`);
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
    if (!outcome.accepted && attempt < REFUSED_ATTEMPTS) {
      retry = 5 * attempt;
      continue;
    }
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
  return { projected, ...(retry ? { retry } : {}) };
}
