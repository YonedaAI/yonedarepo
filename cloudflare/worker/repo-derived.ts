// Derived data over immutable objects: code search (over repo-search-index), path history
// and blame. Index builds run eagerly after landing (queue) and lazily on demand.
import { noteBundles } from './repo-bundles';
import { emitChangeLog } from './repo-changelog';
import { compactAfterLanding } from './repo-compaction';
import { compute } from './repo-compute';
import { keepAllowed, requirePath } from './repo-grants';
import { fanoutHooks } from './repo-hooks';
import { withObjects } from './repo-object-compute';
import { blobWaves } from './repo-object-waves';
import { toBase64 } from './repo-objects';
import { ApiError, caller, type Json, RepoContext, target } from './repo-ops';
import { searchSegments, segmentsIn } from './repo-search-index';
import { writeSeed } from './repo-seed';
import { timed } from './repo-timing';
import type { Env, Envelope } from './types';

const MAX_RESULTS = 200;
/** Candidate files whose content one grep wave reads. */
const GREP_WAVE = 128;
/** Files not content-searched that an answer names (all are counted). */
const SKIPPED_LISTED = 50;
/** `{ at }` when the caller asked for an earlier log version (time travel). */
const asOf = (args: Json) =>
  args.at === undefined || args.at === null || args.at === '' ? {} : { at: Number(args.at) };

export async function search(ctx: RepoContext, args: Json) {
  const query = String(args.query ?? args.q ?? '');
  if (query.length < 2 || query.length > 200)
    throw new ApiError('INVALID_INPUT', 'query must be 2-200 characters');
  const where = await target(ctx, args.commit ?? args.ref, args.at);
  const { indexes, built } = await searchSegments(ctx, where.tree);
  const objects = await ctx.objects();
  const prefix = String(args.path ?? '');
  const limit = Math.min(Number(args.limit ?? 50) || 50, MAX_RESULTS);
  const results: Json[] = [];
  // Files whose content is not searched (too large, binary), and why.
  const skipped: Json[] = [];
  let skippedCount = 0;
  const under = (path: unknown) => !prefix || String(path).startsWith(prefix);
  // Candidates of every partition first (grants filter them before any content is read or
  // counted), then their files a wave at a time in a few ranged reads, in order, until the
  // limit: read one by one, each file waited on its own walk down the read tiers.
  const files: Json[] = [];
  for (const index of indexes)
    if (index.refused) {
      skippedCount++;
      skipped.push({ path: index.partition.prefix || '/', reason: index.refused });
    }
  for await (const { partition, segment } of segmentsIn(ctx, indexes)) {
    const { candidates, unindexed } = compute({
      op: 'search_segment',
      segment_b64: toBase64(segment),
      prefix: partition.prefix,
      query,
    });
    for (const file of await keepAllowed(
      ctx,
      (unindexed as Json[]).filter((f) => under(f.path)),
    )) {
      skippedCount++;
      if (skipped.length < SKIPPED_LISTED) skipped.push(file);
    }
    for (const file of await keepAllowed(ctx, candidates as Json[]))
      if (under(file.path)) files.push(file);
  }
  for (let i = 0; i < files.length && results.length < limit; i += GREP_WAVE) {
    const wave = files.slice(i, i + GREP_WAVE);
    const content = new Map<string, Uint8Array>();
    const indexed = wave.filter((f) => f.indexed).map((f) => String(f.id));
    await timed('search.files', async () => {
      for await (const read of blobWaves(objects, indexed))
        for (const [id, data] of read) content.set(id, data);
    });
    for (const file of wave) {
      if (results.length >= limit) break;
      const data = content.get(file.id);
      const lines = data
        ? compute({
            op: 'grep',
            id: file.id,
            query,
            ignore_case: args.ignore_case === true,
            blobs: { [file.id]: toBase64(data) },
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
    skipped_files: skipped,
    skipped_count: skippedCount,
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
