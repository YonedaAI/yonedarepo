// Derived data over immutable objects: code search, path history and blame. Search
// segments are keyed by partition (subtree) id in R2, so a segment is built once and
// reused by every commit and branch containing that subtree; only changed partitions
// are ever indexed. Builds run eagerly after landing (queue) and lazily on demand.
// A segment's paths are relative to its partition, and each read passes the partition's
// prefix, so a renamed or duplicated directory reuses the segment under its own path.
import { noteBundles } from './repo-bundles';
import { emitChangeLog } from './repo-changelog';
import { compactAfterLanding } from './repo-compaction';
import { compute } from './repo-compute';
import { keepAllowed, requirePath } from './repo-grants';
import { fanoutHooks } from './repo-hooks';
import { blobWaves, inWaves } from './repo-object-waves';
import { type CachedObject, toBase64 } from './repo-objects';
import { ApiError, caller, type Json, RepoContext, target } from './repo-ops';
import { writeSeed } from './repo-seed';
import type { Env, Envelope } from './types';

const MAX_RESULTS = 200;
/** `{ at }` when the caller asked for an earlier log version (time travel). */
const asOf = (args: Json) =>
  args.at === undefined || args.at === null || args.at === '' ? {} : { at: Number(args.at) };

/**
 * Runs a Rust compute op that walks trees and reads blobs, supplying both on request, a
 * bounded wave at a time. Blob bytes beyond `maxBytes` refuse with TOO_LARGE: every
 * supplied object goes into one compute call, and Wasm memory never shrinks once grown.
 */
export async function withObjects(
  ctx: RepoContext,
  input: Json,
  known: CachedObject[] = [],
  maxBytes = Number.POSITIVE_INFINITY,
) {
  const objects = await ctx.objects();
  const trees: Json = {};
  const blobs: Json = {};
  let bytes = 0;
  // Objects the caller already holds (a commit being built) are only supplied on request.
  const held = new Map(known.map((o) => [o.id, o]));
  const tree = async (id: string) => {
    const object = held.get(id);
    trees[id] = object?.kind === 'tree' ? object.entries : await objects.tree(id);
  };
  const supply = (id: string, data_b64: string) => {
    bytes += (data_b64.length * 3) / 4;
    if (bytes > maxBytes)
      throw new ApiError('TOO_LARGE', `More than ${maxBytes} bytes of files to read`);
    blobs[id] = data_b64;
  };
  for (let round = 0; round <= 256; round++) {
    const result = compute({ ...input, trees, blobs });
    if (result.need_trees) await inWaves(result.need_trees as string[], tree);
    else if (result.need_blobs) {
      const read: string[] = [];
      for (const id of result.need_blobs as string[]) {
        const object = held.get(id);
        if (object?.kind === 'blob') supply(id, object.data_b64);
        else read.push(id);
      }
      for await (const wave of blobWaves(objects, read))
        for (const [id, data] of wave) supply(id, toBase64(data));
    } else return result;
  }
  throw new ApiError('INVALID_INPUT', 'Too many object rounds');
}

// `search/v2`: segments hold partition-relative paths. v1 segments named the directory
// they were first built for, so they are never read again.
const segmentKey = (repo: string, key: string) => `derived/v1/${repo}/search/v2/${key}`;

/** Blob bytes one partition's index may read (a larger one is skipped, as a partition of
 * too many files is). */
const INDEX_BYTES = 8 * 1024 * 1024;
/** Cached segments read at a time. */
const SEGMENT_READS = 8;

/** Segments for a root tree, building missing ones. Returns how many were built. Cached
 * segments are read side by side; missing ones are built one at a time, since a build
 * holds its partition's files. */
export async function searchSegments(ctx: RepoContext, root: string) {
  const { partitions } = await withObjects(ctx, { op: 'search_plan', root });
  let built = 0;
  const segments: Json[] = [];
  for (let i = 0; i < partitions.length; i += SEGMENT_READS)
    segments.push(
      ...(await Promise.all(
        (partitions as Json[]).slice(i, i + SEGMENT_READS).map(async (p) => {
          const cached = await ctx.env.OBJECTS.get(segmentKey(ctx.repo, p.key));
          return { partition: p, ...(cached ? { segment: await cached.json<Json>() } : {}) };
        }),
      )),
    );
  for (const entry of segments) {
    if (entry.segment) continue;
    const p = entry.partition;
    const result: Json = await withObjects(
      ctx,
      { op: 'index_partition', tree: p.tree, shallow: p.shallow },
      [],
      INDEX_BYTES,
    ).catch((e) => {
      if (e instanceof ApiError && e.code === 'TOO_LARGE') return { too_large: true };
      throw e;
    });
    if (result.too_large) {
      entry.too_large = true;
      continue;
    }
    await ctx.env.OBJECTS.put(segmentKey(ctx.repo, p.key), JSON.stringify(result.segment));
    built++;
    entry.segment = result.segment;
  }
  return { segments, built };
}

export async function search(ctx: RepoContext, args: Json) {
  const query = String(args.query ?? args.q ?? '');
  if (query.length < 2 || query.length > 200)
    throw new ApiError('INVALID_INPUT', 'query must be 2-200 characters');
  const where = await target(ctx, args.commit ?? args.ref, args.at);
  const { segments, built } = await searchSegments(ctx, where.tree);
  const objects = await ctx.objects();
  const prefix = String(args.path ?? '');
  const limit = Math.min(Number(args.limit ?? 50) || 50, MAX_RESULTS);
  const results: Json[] = [];
  const skipped: string[] = [];
  for (const entry of segments) {
    if (entry.too_large) {
      skipped.push(entry.partition.prefix || '/');
      continue;
    }
    const { candidates } = compute({
      op: 'search_segment',
      segment: entry.segment,
      prefix: entry.partition.prefix,
      query,
    });
    // Grants filter candidates before any content is read or counted.
    for (const file of await keepAllowed(ctx, candidates as Json[])) {
      if (prefix && !String(file.path).startsWith(prefix)) continue;
      if (results.length >= limit) break;
      const lines = file.indexed
        ? compute({
            op: 'grep',
            id: file.id,
            query,
            ignore_case: args.ignore_case === true,
            blobs: { [file.id]: toBase64(await objects.blob(file.id)) },
          }).lines
        : [];
      const pathHit = String(file.path).toLowerCase().includes(query.toLowerCase());
      if (lines.length > 0 || pathHit) results.push({ path: file.path, id: file.id, lines });
    }
  }
  return {
    commit: where.commit,
    query,
    results,
    partitions_built: built,
    skipped_partitions: skipped,
  };
}

export async function blame(ctx: RepoContext, args: Json) {
  const path = String(args.path ?? '');
  await requirePath(ctx, path);
  const ref = args.ref ?? 'main';
  const history = await ctx.call({
    op: 'repo_path_history',
    ref,
    path,
    limit: Number(args.limit ?? 200),
    ...asOf(args),
  });
  const versions = (history.commits as Json[])
    .filter((c) => c.path === path && c.new_blob)
    .reverse()
    .map((c) => ({ commit: c.commit, blob: c.new_blob }));
  if (versions.length === 0) throw new ApiError('NOT_FOUND', `${path} has no history on ${ref}`);
  const result = await withObjects(ctx, { op: 'blame', versions });
  return { ref, path, lines: result.lines, versions: versions.length };
}

export function pathHistory(ctx: RepoContext, args: Json) {
  return ctx.call({
    op: 'repo_path_history',
    ref: args.ref ?? 'main',
    path: args.path,
    limit: args.limit,
    ...asOf(args),
  });
}

/** Eager derived builds after a landing: the new head's search segments. */
export async function deriveAfterLanding(env: Env, envelope: Envelope) {
  // Change-log analytics and webhooks first and independent of the builds below; neither
  // throws.
  await emitChangeLog(env, envelope.repo_id);
  await fanoutHooks(env, envelope.repo_id);
  const ctx = new RepoContext(
    env,
    envelope.repo_id,
    caller(env, envelope.repo_id, { _system: 'derive' }),
  );
  const head = await ctx.call({ op: 'repo_snapshot', ref: envelope.job_id });
  // A push's bundles are then read in bulk, not one staged read per file.
  if ((await ctx.status()).bundled) noteBundles(envelope.repo_id);
  const segments = await searchSegments(ctx, head.tree);
  // Warm-start seed for check runs on nearby commits; a failure only costs them speed.
  const at = { commit: String(head.commit), tree: String(head.tree) };
  await writeSeed(env, envelope.repo_id, await ctx.objects(), envelope.job_id, at).catch(() => {});
  // Keeps the authority's log a bounded tail; never throws.
  await compactAfterLanding(env, envelope.repo_id, Number(head.version));
  return segments;
}

export async function dispatchDerive(env: Env, repo: string, ref: string) {
  await env.PLATFORM_QUEUE.send({ v: 1, kind: 'platform_derive', repo_id: repo, job_id: ref });
}
