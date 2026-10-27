// Derived data over immutable objects: code search, path history and blame. Search
// segments are keyed by partition (subtree) id in R2, so a segment is built once and
// reused by every commit and branch containing that subtree; only changed partitions
// are ever indexed. Builds run eagerly after landing (queue) and lazily on demand.
// A segment's paths are relative to its partition, and each read passes the partition's
// prefix, so a renamed or duplicated directory reuses the segment under its own path.
import { emitChangeLog } from './repo-changelog';
import { compute } from './repo-compute';
import { keepAllowed, requirePath } from './repo-grants';
import { type CachedObject, toBase64 } from './repo-objects';
import { ApiError, caller, type Json, RepoContext, target } from './repo-ops';
import { writeSeed } from './repo-seed';
import type { Env, Envelope } from './types';

const MAX_RESULTS = 200;
/** `{ at }` when the caller asked for an earlier log version (time travel). */
const asOf = (args: Json) =>
  args.at === undefined || args.at === null || args.at === '' ? {} : { at: Number(args.at) };

/** Runs a Rust compute op that walks trees and reads blobs, supplying both on request. */
export async function withObjects(ctx: RepoContext, input: Json, known: CachedObject[] = []) {
  const objects = await ctx.objects();
  const trees: Json = {};
  const blobs: Json = {};
  // Objects the caller already holds (a commit being built) are only supplied on request.
  const held = new Map(known.map((o) => [o.id, o]));
  const supply = async (id: string, kind: 'tree' | 'blob') => {
    const object = held.get(id);
    if (object?.kind === 'tree' && kind === 'tree') return object.entries;
    if (object?.kind === 'blob' && kind === 'blob') return object.data_b64;
    return kind === 'tree' ? objects.tree(id) : toBase64(await objects.blob(id));
  };
  for (let round = 0; round <= 256; round++) {
    const result = compute({ ...input, trees, blobs });
    if (result.need_trees)
      await Promise.all(
        (result.need_trees as string[]).map(async (id) => (trees[id] = await supply(id, 'tree'))),
      );
    else if (result.need_blobs)
      await Promise.all(
        (result.need_blobs as string[]).map(async (id) => (blobs[id] = await supply(id, 'blob'))),
      );
    else return result;
  }
  throw new ApiError('INVALID_INPUT', 'Too many object rounds');
}

// `search/v2`: segments hold partition-relative paths. v1 segments named the directory
// they were first built for, so they are never read again.
const segmentKey = (repo: string, key: string) => `derived/v1/${repo}/search/v2/${key}`;

/** Segments for a root tree, building missing ones. Returns how many were built. */
export async function searchSegments(ctx: RepoContext, root: string) {
  const { partitions } = await withObjects(ctx, { op: 'search_plan', root });
  let built = 0;
  const segments = await Promise.all(
    (partitions as Json[]).map(async (p) => {
      const key = segmentKey(ctx.repo, p.key);
      const cached = await ctx.env.OBJECTS.get(key);
      if (cached) return { partition: p, segment: await cached.json<Json>() };
      const result = await withObjects(ctx, {
        op: 'index_partition',
        tree: p.tree,
        shallow: p.shallow,
      });
      if (result.too_large) return { partition: p, too_large: true };
      await ctx.env.OBJECTS.put(key, JSON.stringify(result.segment));
      built++;
      return { partition: p, segment: result.segment };
    }),
  );
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
  // Change-log analytics first and independent of the builds below; it never throws.
  await emitChangeLog(env, envelope.repo_id);
  const ctx = new RepoContext(
    env,
    envelope.repo_id,
    caller(env, envelope.repo_id, { _system: 'derive' }),
  );
  const head = await ctx.call({ op: 'repo_snapshot', ref: envelope.job_id });
  const segments = await searchSegments(ctx, head.tree);
  // Warm-start seed for check runs on nearby commits; a failure only costs them speed.
  const at = { commit: String(head.commit), tree: String(head.tree) };
  await writeSeed(env, envelope.repo_id, await ctx.objects(), envelope.job_id, at).catch(() => {});
  return segments;
}

export async function dispatchDerive(env: Env, repo: string, ref: string) {
  await env.PLATFORM_QUEUE.send({ v: 1, kind: 'platform_derive', repo_id: repo, job_id: ref });
}
