// Contract records tied to symbols. Derived contracts and lexical references come from
// per-file facts computed in Rust and cached by blob id; authored contracts are recorded
// by the SourceRepository authority against a symbol handle's commit and node digest.
// Which contract governs a symbol (authored, derived or stale) is decided in Rust.
import { fileAt, handleOf } from './repo-code';
import { compute } from './repo-compute';
import { withObjects } from './repo-object-compute';
import { ApiError, type Json, type RepoContext } from './repo-ops';

const RECORD_PATHS = 1000;

/** One blob's facts, named by language (extension) and blob id. */
export function factsName(path: string, id: string) {
  const ext = path.includes('.') ? path.slice(path.lastIndexOf('.') + 1) : 'none';
  return `${ext}/${id}`;
}

/** Where one blob's facts are cached. */
export const factsKey = (repo: string, path: string, id: string) =>
  `derived/v1/${repo}/facts/v1/${factsName(path, id)}`;

/** Symbols, node digests, derived contracts and references of one blob (cached by id). */
export async function factsOf(ctx: RepoContext, path: string, id: string): Promise<Json> {
  const key = factsKey(ctx.repo, path, id);
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
