// Quarantine: the owner (or an admin) withholds a blob, or a session record's text, without
// rewriting any id (repo_store/quarantine.rs decides; repo-quarantine-guard refuses reads).
// The change is in force everywhere before it answers: main's published head is reloaded
// and every isolate's older copy has expired (`accessEverywhere`).
//
// Purge deletes a blob's bytes from what the platform keeps in R2 and this colo's edge:
// the store of record and cache keys, its frame in any push bundle (zeroed in place, so
// the bundle's index stays valid), and every derived cache and warm-start seed of the
// repository (search indexes, stored packs, symbols, facts and views hold file content;
// all are rebuilt on demand). Other colos' edge copies and an Artifacts store's Git
// objects cannot be deleted per object from here; no read reaches them, since a purged
// blob stays withheld. A session record's text is cleared by the authority itself, and
// its stored transcript document is deleted here. A purge runs once the record's
// retention passes (the quarantine job, leased and fenced like the LFS sweep), or at once
// when the owner repeats the target id as `confirm`.
import { purgePrefix } from './repo-admin';
import { bundleKey, type Location, locate } from './repo-bundles';
import { edgeDelete } from './repo-cache-tiers';
import { accessEverywhere } from './repo-head';
import { RepoObjects } from './repo-objects';
import { ApiError, caller, type Json, type RepoContext, target, walk } from './repo-ops';
import { seedPrefix } from './repo-seed';
import { transcriptKey } from './repo-session-records';
import { ownSpec, parseStore } from './repo-stores';

/** Every cache derived from the repository's content (search, packs, symbols, facts, views). */
const derivedPrefix = (repo: string) => `derived/v1/${repo}/`;

import type { Env, Envelope } from './types';

/** Records one job claim takes (the authority's MAX_CLAIM). */
const CLAIM = 100;
/** Claims one job works through before it hands on to its next run. */
const ROUNDS = 10;
/** Bytes are deleted only with this much of the lease left, so no delete outlives it. */
const MARGIN_MS = 60_000;
/** The longest delay a queue message takes; a later due time is reached in steps. */
const MAX_DELAY_SECONDS = 12 * 60 * 60;

type Claim = {
  id: number;
  epoch: number;
  target: { kind: string; id: string };
  /** A session target's stored transcript document, which the purge deletes. */
  transcript_sha256?: string | null;
};

/** `/repos/:id/quarantine[/<record>/<action>]`. */
export async function quarantineRoute(
  ctx: RepoContext,
  method: string,
  record: string | undefined,
  action: string | undefined,
  body: () => Promise<Json>,
) {
  if (!record && method === 'GET') return ctx.call({ op: 'repo_quarantines' });
  if (!record && method === 'POST') return quarantine(ctx, await body());
  const id = Number(record);
  if (method !== 'POST' || !Number.isSafeInteger(id))
    throw new ApiError('NOT_FOUND', 'Unknown quarantine path');
  if (action === 'release') {
    const released = await ctx.call({ op: 'repo_quarantine_release', id });
    await accessEverywhere(ctx.env, ctx.repo);
    return released;
  }
  if (action === 'purge') return purgeNow(ctx, id, (await body()).confirm);
  throw new ApiError('NOT_FOUND', 'Unknown quarantine path');
}

/** `POST /quarantine {blob | path (at ref, default main) | session, reason, retain_days?}`. */
async function quarantine(ctx: RepoContext, args: Json) {
  const what = await targetOf(ctx, args);
  const made = await ctx.call({
    op: 'repo_quarantine',
    ...what,
    reason: args.reason,
    retain_days: args.retain_days,
  });
  await accessEverywhere(ctx.env, ctx.repo);
  await schedulePurge(ctx.env, ctx.repo, made.purge_at);
  return made;
}

/** The target named by id, or the blob at `path` (resolved at `ref`). */
async function targetOf(ctx: RepoContext, args: Json): Promise<Json> {
  if (args.session !== undefined && args.session !== null)
    return { target: { kind: 'session', id: String(args.session) } };
  const path = typeof args.path === 'string' && args.path ? args.path : null;
  if (typeof args.blob === 'string') return { target: { kind: 'blob', id: args.blob }, path };
  if (!path) throw new ApiError('INVALID_INPUT', 'Name a blob, a path or a session');
  const where = await target(ctx, args.ref ? String(args.ref) : undefined);
  const entry = await walk(await ctx.objects(), where.tree, path);
  if (entry.type === 'tree' || entry.type === 'gitlink')
    throw new ApiError('INVALID_INPUT', `${path} is not a file`);
  return { target: { kind: 'blob', id: entry.id }, path };
}

/** `POST /quarantine/:record/purge {confirm}`: purges one record now. */
async function purgeNow(ctx: RepoContext, id: number, confirm: unknown) {
  const { claims } = await ctx.call({ op: 'repo_quarantine_purge', id, confirm });
  const { object_store } = await ctx.status();
  await purgeContent(ctx.env, ctx.repo, String(object_store ?? ''), claims);
  const reported = { op: 'repo_quarantine_purged', claims: fenced(claims) };
  return ctx.call(reported);
}

const fenced = (claims: Claim[]) => claims.map(({ id, epoch }) => ({ id, epoch }));

/** Deletes the bytes `claims` name (see the header): blobs, and the transcript documents
 * of session records (the authority clears their text). Idempotent. */
export async function purgeContent(env: Env, repo: string, spec: string, claims: Claim[]) {
  const transcripts = claims
    .map((c) => c.transcript_sha256)
    .filter((sha): sha is string => typeof sha === 'string' && /^[0-9a-f]{64}$/.test(sha));
  if (transcripts.length)
    await env.OBJECTS.delete(transcripts.map((sha) => transcriptKey(repo, sha)));
  const blobs = claims.filter((c) => c.target.kind === 'blob').map((c) => c.target.id);
  if (blobs.length === 0) return;
  const objects = new RepoObjects(env, repo, parseStore(env, spec));
  const keys = blobs.flatMap((id) => [objects.rawKey(id), objects.key(id)]);
  // A repository on the R2 object store (local development) keeps its own copy too.
  const r2 = /^r2:([A-Za-z0-9._-]+)$/.exec(ownSpec(spec));
  if (r2) keys.push(...blobs.map((id) => `store/v1/${r2[1]}/objects/${id}`));
  await env.OBJECTS.delete(keys);
  await Promise.all(blobs.map((id) => edgeDelete(repo, id)));
  await zeroBundled(env, repo, blobs);
  await purgePrefix(env, derivedPrefix(repo));
  await purgePrefix(env, seedPrefix(repo));
}

/** Overwrites the frames of `blobs` in the push bundles holding them with zeros, a bundle
 * at a time, streamed (offsets and sizes stay, so the bundle index needs no change). */
async function zeroBundled(env: Env, repo: string, blobs: string[]) {
  const where = await locate(
    env,
    repo,
    blobs.map((id) => ({ id, kind: 'blob' })),
  );
  const byBundle = new Map<string, Location[]>();
  for (const l of where.values()) byBundle.set(l.bundle, [...(byBundle.get(l.bundle) ?? []), l]);
  for (const [bundle, places] of byBundle) {
    const key = bundleKey(repo, bundle);
    const stored = await env.OBJECTS.get(key);
    if (!stored) continue;
    const ranges = places.map((l) => [l.at, l.at + l.size] as const);
    let offset = 0;
    const zeroing = new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, out) {
        const start = offset;
        offset += chunk.length;
        const hit = ranges.filter(([a, b]) => a < offset && b > start);
        if (hit.length === 0) return out.enqueue(chunk);
        const copy = chunk.slice();
        for (const [a, b] of hit)
          copy.fill(0, Math.max(a - start, 0), Math.min(b - start, copy.length));
        out.enqueue(copy);
      },
    });
    const sized = new FixedLengthStream(stored.size);
    const piped = stored.body.pipeThrough(zeroing).pipeTo(sized.writable);
    await Promise.all([
      env.OBJECTS.put(key, sized.readable, { customMetadata: stored.customMetadata }),
      piped,
    ]);
  }
}

/** Schedules the quarantine job of `repo` for `at` (ms; null or undefined: nothing to do). */
export async function schedulePurge(env: Env, repo: string, at: unknown) {
  if (typeof at !== 'number') return;
  const delaySeconds = Math.min(
    Math.max(Math.ceil((at - Date.now()) / 1000), 0),
    MAX_DELAY_SECONDS,
  );
  const envelope: Envelope = {
    v: 1,
    kind: 'platform_quarantine',
    repo_id: repo,
    job_id: `quarantine-${at}`,
  };
  await env.PLATFORM_QUEUE.send(envelope, delaySeconds > 0 ? { delaySeconds } : undefined);
}

/** Purges `repo`'s due records; answers when the job is next due (null: nothing waits). */
export async function purgeDue(env: Env, repo: string): Promise<number | null> {
  const call = caller(env, repo, { _system: 'quarantine' });
  const { object_store } = await call({ op: 'repo_status' });
  for (let round = 0; round < ROUNDS; round++) {
    const claimed = await call({ op: 'repo_quarantine_claim', limit: CLAIM });
    const claims = claimed.claims as Claim[];
    if (claims.length === 0) return claimed.next_at ?? null;
    // Too little lease left (a slow claim): let it run out; the next run claims again.
    if (claimed.lease_until - Date.now() < MARGIN_MS) return claimed.lease_until;
    await purgeContent(env, repo, String(object_store ?? ''), claims);
    await call({ op: 'repo_quarantine_purged', claims: fenced(claims) });
    if (claims.length < CLAIM) return claimed.next_at ?? null;
  }
  return Date.now();
}

/** The queue job: one purge run, then the next one scheduled. A deleted repository's own
 * purge removes everything, so its quarantine job ends quietly. */
export async function quarantineJob(env: Env, envelope: Envelope) {
  try {
    await schedulePurge(env, envelope.repo_id, await purgeDue(env, envelope.repo_id));
  } catch (e: any) {
    if (!['GONE', 'NOT_FOUND'].includes(e?.code)) throw e;
  }
}
