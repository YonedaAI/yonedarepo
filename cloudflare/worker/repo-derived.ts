// Derived data over immutable objects: code search (over repo-search-index), path history
// and blame. Index builds run eagerly after landing (queue) and lazily on demand.

import { log } from './log';
import { touchActivity } from './repo-activity';
import { noteBundles } from './repo-bundles';
import { emitChangeLog } from './repo-changelog';
import { compactAfterLanding } from './repo-compaction';
import { requirePath } from './repo-grants';
import { fanoutHooks } from './repo-hooks';
import { memoryMatches } from './repo-memories';
import { withObjects } from './repo-object-compute';
import { ApiError, caller, type Json, RepoContext, target } from './repo-ops';
import { schedulePackBuild } from './repo-pack-jobs';
import { searchCode } from './repo-search-code';
import { searchSegments } from './repo-search-index';
import { codeKey, completedCode } from './repo-search-memo';
import { refreshSummary } from './repo-search-summary';
import { writeSeed } from './repo-seed';
import { sampleStorage } from './repo-storage';
import { record } from './repo-timing';
import { viewFacts } from './repo-view-facts';
import { carriedQueue } from './request-scope';
import type { Env, Envelope } from './types';

/** `{ at }` when the caller asked for an earlier log version (time travel). */
const asOf = (args: Json) =>
  args.at === undefined || args.at === null || args.at === '' ? {} : { at: Number(args.at) };

/** The groups one search answers: code (files and lines at a revision), then memories,
 * commits, session records and change requests (the repository's records). */
export const SEARCH_GROUPS = ['code', 'memories', 'commits', 'sessions', 'changes'] as const;
const RECORD_GROUPS = ['commits', 'sessions', 'changes'];
/** Results per record group when `limit` is not given, and at most. */
const RECORD_LIMIT = 10;
const MAX_RECORD_LIMIT = 50;

/** `groups` as a list or a comma-separated string (a query parameter); all when absent. */
function searchGroups(args: Json): string[] {
  const raw = args.groups;
  if (raw === undefined || raw === null || raw === '') return [...SEARCH_GROUPS];
  const asked = (Array.isArray(raw) ? raw : String(raw).split(',')).map((g) => String(g).trim());
  if (asked.length === 0 || asked.some((g) => !(SEARCH_GROUPS as readonly string[]).includes(g)))
    throw new ApiError('INVALID_INPUT', `groups lists ${SEARCH_GROUPS.join(', ')}`);
  return asked;
}

/** A group's read settled into a value or an error, raised once the code search is done
 * (a failure is not left unhandled while the code is read). */
const settled = <T>(work: Promise<T>) =>
  work.then(
    (found) => ({ found }),
    (error: unknown) => ({ error }),
  );
const raised = async <T>(work: Promise<{ found: T } | { error: unknown }>) => {
  const outcome = await work;
  if ('error' in outcome) throw outcome.error;
  return outcome.found;
};

export async function search(ctx: RepoContext, args: Json) {
  const query = String(args.query ?? args.q ?? '');
  if (query.length < 2 || query.length > 200)
    throw new ApiError('INVALID_INPUT', 'query must be 2-200 characters');
  const groups = searchGroups(args);
  // Memories whose text matches, read alongside the code (a separate group).
  const memories =
    !groups.includes('memories') || args.memories === false || args.memories === 'false'
      ? Promise.resolve({ found: null })
      : settled(memoryMatches(ctx, query));
  // Commits, session records and change requests whose text matches (each its own group).
  const asked = RECORD_GROUPS.filter((g) => groups.includes(g));
  const recordLimit = Math.min(
    Number(args.limit ?? RECORD_LIMIT) || RECORD_LIMIT,
    MAX_RECORD_LIMIT,
  );
  const records = asked.length
    ? settled(ctx.call({ op: 'repo_search_records', query, groups: asked, limit: recordLimit }))
    : Promise.resolve({ found: {} as Json });
  const answer = async (code: Json) => {
    const found = (await raised(records)) as Json;
    return {
      ...code,
      query,
      groups,
      memories: await raised(memories),
      commits: found.commits ?? null,
      sessions: found.sessions ?? null,
      changes: found.changes ?? null,
    };
  };
  if (!groups.includes('code'))
    return answer({
      commit: null,
      results: [],
      partitions_built: 0,
      skipped_files: [],
      skipped_count: 0,
    });
  const where = await target(ctx, args.commit ?? args.ref, args.at);
  let key: string | null = null;
  if (ctx.env.SEARCH_CODE_MEMO === 'on') {
    // Exact target admission above and this authority answer are fresh on every hit.
    const status = await ctx.call({ op: 'repo_status' });
    ctx.retainStatus(status);
    key = codeKey(ctx.repo, status, where, query, args);
  }
  const cached = key && completedCode.get(key);
  if (cached) {
    record('search.code.hit', 0);
    return answer(cached);
  }
  record('search.code.miss', 0);
  const { value: code, reusable } = await searchCode(ctx, args, query, where);
  const result = await answer(code);
  // A failed record/memory group, segment or file read must not publish a partial result.
  if (key && reusable) completedCode.put(key, { ...code, partitions_built: 0 });
  return result;
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
  // Change-log analytics, webhooks and the Home's activity row first and independent of the
  // builds below; none throws.
  await emitChangeLog(env, envelope.repo_id);
  await fanoutHooks(env, envelope.repo_id);
  // Here, not after the builds: the touch must not wait for them or depend on them, and a
  // size sampled at the end would need a D1 write of its own.
  await touchActivity(
    env,
    envelope.repo_id,
    Date.now(),
    await sampleStorage(env, envelope.repo_id),
  );
  const ctx = new RepoContext(
    env,
    envelope.repo_id,
    caller(env, envelope.repo_id, { _system: 'derive' }),
  );
  // Before the head is read, and after the touch: what lands from here on shows as activity.
  const readAt = Date.now();
  const head = await ctx.call({ op: 'repo_snapshot', ref: envelope.job_id }).catch((e) => {
    // The branch went away after this job was queued (a deleted scratch branch): there is
    // nothing to derive, and retrying would not change that.
    if (e?.code === 'NOT_FOUND') return null;
    throw e;
  });
  if (!head) return null;
  // A push's bundles are then read in bulk, not one staged read per file. Main's clone
  // packs are built ahead of its next clones (a repository pushed only through the API
  // holds no bundles and clones quickly); a lost message costs the next clone its speed.
  if ((await ctx.status()).bundled) {
    noteBundles(envelope.repo_id);
    if (head.ref === 'refs/heads/main')
      await schedulePackBuild(env, envelope.repo_id, String(head.commit)).catch((e) =>
        log.warn('git.pack.not_scheduled', { error: e }),
      );
  }
  const segments = await searchSegments(ctx, head.tree);
  await refreshSummary(ctx, readAt, head, segments.indexes);
  // The head's overview facts; a failure only costs the first view its speed.
  await viewFacts(ctx, String(head.tree)).catch(() => {});
  // Warm-start seed for check runs on nearby commits; a failure only costs them speed.
  const at = { commit: String(head.commit), tree: String(head.tree) };
  await writeSeed(env, envelope.repo_id, await ctx.objects(), envelope.job_id, at).catch(() => {});
  // Keeps the authority's log a bounded tail; never throws.
  await compactAfterLanding(env, envelope.repo_id, Number(head.version));
  return segments;
}

export async function dispatchDerive(env: Env, repo: string, ref: string) {
  await carriedQueue(env.PLATFORM_QUEUE).send({
    v: 1,
    kind: 'platform_derive',
    repo_id: repo,
    job_id: ref,
  });
}
