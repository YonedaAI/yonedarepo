// Contract records tied to symbols. Derived contracts and lexical references come from
// per-file facts computed in Rust and cached by blob id; authored contracts are recorded
// by the SourceRepository authority against a symbol handle's commit and node digest.
// Which contract governs a symbol (authored, derived or stale) is decided in Rust.
import { fileAt, handleOf } from './repo-code';
import { compute } from './repo-compute';
import { keepAllowed } from './repo-grants';
import { withObjects } from './repo-object-compute';
import { ApiError, type Json, type RepoContext, withTrees } from './repo-ops';

const FACTS_BATCH = 32;
const RECORD_PATHS = 1000;

/** Symbols, node digests, derived contracts and references of one blob (cached by id). */
export async function factsOf(ctx: RepoContext, path: string, id: string): Promise<Json> {
  const ext = path.includes('.') ? path.slice(path.lastIndexOf('.') + 1) : 'none';
  const key = `derived/v1/${ctx.repo}/facts/v1/${ext}/${id}`;
  const cached = await ctx.env.OBJECTS.get(key);
  if (cached) return cached.json<Json>();
  const facts = await withObjects(ctx, { op: 'code_facts', path, id });
  await ctx.env.OBJECTS.put(key, JSON.stringify(facts));
  return facts;
}

/** Authored contract records for `paths`, as of log version `at` (default: now). */
export async function recordsFor(ctx: RepoContext, paths: string[], at?: unknown) {
  const version = at === undefined || at === null || at === '' ? {} : { at: Number(at) };
  const records: Json[] = [];
  for (let i = 0; i < paths.length; i += RECORD_PATHS) {
    const chunk = paths.slice(i, i + RECORD_PATHS);
    records.push(...(await ctx.call({ op: 'repo_contracts', paths: chunk, ...version })).records);
  }
  return records;
}

/**
 * Every file a revision-wide view may analyse: inside the caller's grant (hidden files
 * never enter the computation, so nothing about them can leak into a view), in a
 * supported language, bounded in number. Each comes with its facts.
 */
export async function revisionFiles(ctx: RepoContext, tree: string, at?: unknown) {
  const objects = await ctx.objects();
  const { changes } = await withTrees(objects, { op: 'tree_diff', old: null, new: tree });
  const listed = (changes as Json[]).map((c) => ({
    path: c.path,
    id: c.new?.id,
    type: c.new?.type,
  }));
  const plan = compute({ op: 'view_files', files: await keepAllowed(ctx, listed) });
  const files: Json[] = [];
  for (let i = 0; i < plan.files.length; i += FACTS_BATCH)
    files.push(
      ...(await Promise.all(
        (plan.files as Json[]).slice(i, i + FACTS_BATCH).map(async (f) => ({
          path: f.path,
          facts: await factsOf(ctx, f.path, f.id),
        })),
      )),
    );
  const records = await recordsFor(
    ctx,
    files.map((f) => f.path),
    at,
  );
  return { files, records, truncated: plan.truncated as boolean, limit: plan.limit as number };
}

/** The governing contract of one symbol at a commit, branch or past version. */
export async function symbolContract(ctx: RepoContext, args: Json) {
  const name = String(args.symbol ?? '');
  const { where, path, id } = await fileAt(ctx, args);
  const facts = await factsOf(ctx, path, id);
  const records = await recordsFor(ctx, [path], args.commit ? undefined : args.at);
  const view = compute({
    op: 'symbol_contract',
    path,
    symbol: name,
    files: [{ path, facts }],
    records,
  });
  return { commit: where.commit, ...view, handle: handleOf(where.commit, path, view.symbol) };
}

/**
 * Records an authored contract for the symbol a handle names. The handle must still
 * match the symbol at its commit; the record binds to that commit and node digest, so
 * later changes to the symbol make it stale rather than silently wrong.
 */
export async function recordContract(ctx: RepoContext, args: Json) {
  const handle = args.handle;
  if (!handle?.commit || !handle?.path || !handle?.symbol_path || !handle?.digest)
    throw new ApiError(
      'INVALID_INPUT',
      'handle must come from symbol_get, symbol_list or symbol_contract',
    );
  if (!args.contract || typeof args.contract !== 'object' || Array.isArray(args.contract))
    throw new ApiError('INVALID_INPUT', 'contract must be an object');
  const { where, path, id } = await fileAt(ctx, { commit: handle.commit, path: handle.path });
  const facts = await factsOf(ctx, path, id);
  if (facts.parse_error) throw new ApiError('PARSE_FAILED', `${path} does not parse`);
  const symbol = (facts.symbols as Json[]).find((s) => s.symbol_path === handle.symbol_path);
  if (!symbol || symbol.digest !== handle.digest)
    throw new ApiError(
      'STALE_HANDLE',
      `${handle.symbol_path} does not match the handle at ${where.commit}`,
    );
  return ctx.call({
    op: 'repo_record_contract',
    commit: where.commit,
    path,
    symbol_path: symbol.symbol_path,
    node_digest: symbol.digest,
    contract: args.contract,
  });
}
