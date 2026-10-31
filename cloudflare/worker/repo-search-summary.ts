// A repository's search summary (yoneda-core search/summary.rs): main's code-search segments
// folded into one bitset, written to its owner's directory. Runs after a derive job's builds
// and from the operators' backfill; import, create-with-files and fork never run derive, so
// those repositories have no row, which reads as "maybe".
import { audit } from './platform-admin-queries';
import { compute } from './repo-compute';
import { toBase64 } from './repo-objects';
import { ApiError, caller, type Json, RepoContext } from './repo-ops';
import { accountSearchOn, ownerOf } from './repo-search-directory';
import { type PartitionIndex, searchSegments, segmentsIn } from './repo-search-index';
import type { Env, Envelope } from './types';
import { searchDirectory } from './workspace';

export const SUMMARY_JOB = 'platform_search_summary';
/** Segments one summary reads; a repository with more would saturate anyway. */
const SEGMENTS = 256;
/** Repositories one backfill request queues. */
const BACKFILL_PAGE = 100;

const SATURATED = { saturated: true };

/** `indexes` as a summary: its bits, or saturated once there is no point reading on. A
 * directory too large to index is searched by nothing here, so it says nothing either. */
async function summaryOf(ctx: RepoContext, indexes: PartitionIndex[]) {
  if (indexes.some((index) => index.refused)) return SATURATED;
  let bits: string | undefined;
  let read = 0;
  for await (const { partition, segment } of segmentsIn(ctx, indexes)) {
    if (++read > SEGMENTS) return SATURATED;
    const added: Json = compute({
      op: 'search_summary',
      segment_b64: toBase64(segment),
      prefix: partition.prefix,
      ...(bits && { bits }),
    });
    if (added.saturated) return SATURATED;
    bits = added.bits;
  }
  return bits ? { bits } : SATURATED;
}

/** Brings `repo`'s row up to main. `at` is a time before main was read, so that anything
 * newer shows as activity. `head`, with `segments`, is the commit a derive job built when
 * that is main's. Never throws: a summary only narrows a search. */
export async function refreshSummary(
  ctx: RepoContext,
  at: number,
  head?: Json,
  segments?: PartitionIndex[],
) {
  if (!accountSearchOn(ctx.env)) return;
  try {
    const onMain = head?.ref === 'refs/heads/main';
    const main = onMain ? head : await ctx.call({ op: 'repo_snapshot', ref: 'main' });
    const owner = await ownerOf(ctx.env, ctx.repo);
    const row = { repo: ctx.repo, at, commit: String(main.commit) };
    const { current } = await searchDirectory(ctx.env, owner, { op: 'search_touch', ...row });
    if (current) return;
    const indexes =
      onMain && segments ? segments : (await searchSegments(ctx, String(main.tree))).indexes;
    const summary = await summaryOf(ctx, indexes);
    await searchDirectory(ctx.env, owner, { op: 'search_put', ...row, ...summary });
  } catch (e: any) {
    // No main yet is not a failure: there is nothing to summarize.
    if (e?.code !== 'NOT_FOUND') console.warn(`search summary: ${e?.message ?? e}`);
  }
}

/** The backfill's queue job. */
export async function summaryJob(env: Env, envelope: Envelope) {
  const repo = envelope.repo_id;
  const at = Date.now();
  await refreshSummary(new RepoContext(env, repo, caller(env, repo, { _system: 'derive' })), at);
}

/** `POST admin/search-backfill {owner, after?, dry_run?}`: a page of one owner's repositories
 * queued for a summary, each in its own job. `next` is the page after, null at the end. */
export async function backfillSummaries(env: Env, actor: string, body: Json) {
  if (typeof body.owner !== 'string' || !body.owner)
    throw new ApiError('INVALID_INPUT', 'owner is required');
  const dryRun = body.dry_run === true;
  if (!dryRun && !accountSearchOn(env)) throw new ApiError('CONFLICT', 'ACCOUNT_SEARCH is off');
  const { results } = await env.INDEX.prepare(
    'SELECT id FROM platform_repos WHERE workspace=? AND id>? ORDER BY id LIMIT ?',
  )
    .bind(body.owner, String(body.after ?? ''), BACKFILL_PAGE)
    .all<{ id: string }>();
  const next = results.length === BACKFILL_PAGE ? results[results.length - 1].id : null;
  if (dryRun) return { queued: 0, repos: results.length, next };
  await Promise.all(
    results.map(({ id }) =>
      env.PLATFORM_QUEUE.send({ v: 1, kind: SUMMARY_JOB, repo_id: id, job_id: 'backfill' }),
    ),
  );
  await audit(env, actor, 'search.backfill', body.owner, { queued: results.length });
  return { queued: results.length, repos: results.length, next };
}
