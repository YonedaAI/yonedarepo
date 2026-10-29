// Repository memories and the context delivered to coding sessions: the adapter half. The
// authority (repo_store/memory) keeps memories, ranks context and records deliveries; this
// module routes the operations and resolves each anchor at the memory's commit before it
// is recorded: a file anchor gets the file's blob id, a symbol anchor the symbol's node
// digest from the file's facts (cached by blob id, as contracts use them), so the
// authority can tell later when the anchored code changed. Callers name anchors by path
// and symbol only; any blob or digest they send is replaced.

import { fileAt } from './repo-code';
import { factsOf } from './repo-contracts';
import { ApiError, type Json, type RepoContext } from './repo-ops';

/** A list from MCP (an array) or a query string (comma-separated); absent stays null. */
const listOf = (value: unknown) =>
  typeof value === 'string' ? value.split(',').filter(Boolean) : (value ?? null);
const numberOf = (value: unknown) =>
  value === undefined || value === null || value === '' ? null : Number(value);
const flag = (value: unknown) => value === true || value === 'true' || value === '1';

/** The anchors with their blob (files) and node digest (symbols) at `commit`. */
async function resolveAnchors(ctx: RepoContext, commit: string, anchors: unknown) {
  if (anchors === undefined || anchors === null) return [];
  if (!Array.isArray(anchors))
    throw new ApiError('INVALID_INPUT', 'anchors must be a list of {path, symbol_path?}');
  const resolved: Json[] = [];
  for (const anchor of anchors as Json[]) {
    const path = String(anchor?.path ?? '');
    const symbol = anchor?.symbol_path ? String(anchor.symbol_path) : null;
    // A directory anchor names a prefix only (validated by the authority).
    if (path.endsWith('/')) {
      resolved.push({ path, symbol_path: symbol });
      continue;
    }
    const { id } = await fileAt(ctx, { commit, path });
    if (!symbol) {
      resolved.push({ path, blob: id });
      continue;
    }
    const facts = await factsOf(ctx, path, id);
    const found = ((facts.symbols ?? []) as Json[]).find((s) => s.symbol_path === symbol);
    if (!found)
      throw new ApiError('NOT_FOUND', `${path} has no symbol ${symbol} at ${commit.slice(0, 12)}`);
    resolved.push({ path, symbol_path: symbol, blob: id, node_digest: found.digest });
  }
  return resolved;
}

/** Records a memory against `commit` (default: the head of `ref`, default main). */
export async function addMemory(ctx: RepoContext, args: Json) {
  const where = await ctx.call(
    /^[0-9a-f]{40}$/.test(String(args.commit ?? ''))
      ? { op: 'repo_commit', commit: args.commit, brief: true }
      : { op: 'repo_snapshot', ref: args.ref || 'main' },
  );
  const commit = String(where.commit ?? '');
  if (!commit) throw new ApiError('NOT_FOUND', `${args.ref || 'main'} has no commit yet`);
  const record = {
    op: 'repo_memory_add',
    commit,
    kind: args.kind,
    text: args.text,
    session_id: args.session_id || null,
    supersedes: numberOf(args.supersedes),
    draft: args.draft === true,
  };
  // Access, text and credentials are checked before any anchor is read.
  const bare = Array.isArray(args.anchors)
    ? (args.anchors as Json[]).map((a) => ({ path: a?.path, symbol_path: a?.symbol_path }))
    : args.anchors;
  const checked = await ctx.call({ ...record, anchors: bare, dry_run: true });
  if (checked.already || args.dry_run === true) return { ...checked, commit };
  const anchors = await resolveAnchors(ctx, commit, args.anchors);
  return { ...(await ctx.call({ ...record, anchors })), commit };
}

export function listMemories(ctx: RepoContext, args: Json) {
  return ctx.call({
    op: 'repo_memory_list',
    path: args.path || null,
    kind: args.kind || null,
    status: args.status || null,
    session_id: args.session_id || null,
    ref: args.ref || null,
    at: numberOf(args.at),
    before: numberOf(args.before),
    limit: numberOf(args.limit),
  });
}

export function relevantContext(ctx: RepoContext, args: Json) {
  return ctx.call({
    op: 'repo_context_relevant',
    paths: listOf(args.paths),
    symbols: listOf(args.symbols),
    query: args.query || null,
    types: listOf(args.types),
    ref: args.ref || null,
    at: numberOf(args.at),
    fill: flag(args.fill),
    limit: numberOf(args.limit),
    session_id: args.session_id || null,
  });
}

/** Memories whose text matches a search query (the search API's memories group); null for
 * a caller that may not read them (a path-restricted token). */
export async function memoryMatches(ctx: RepoContext, query: string) {
  try {
    const found = await ctx.call({
      op: 'repo_context_relevant',
      query,
      types: ['memory'],
      limit: 10,
    });
    return found.items as Json[];
  } catch (e) {
    if (e instanceof ApiError && e.code === 'FORBIDDEN') return null;
    throw e;
  }
}

export const memoryOperations = {
  git_memory_add: addMemory,
  git_memory_list: listMemories,
  git_memory_show: (ctx: RepoContext, a: Json) =>
    ctx.call({
      op: 'repo_memory_show',
      id: numberOf(a.id),
      at: numberOf(a.at),
      ref: a.ref || null,
    }),
  git_memory_retire: (ctx: RepoContext, a: Json) =>
    ctx.call({ op: 'repo_memory_retire', id: numberOf(a.id), reason: a.reason ?? null }),
  git_context_relevant: relevantContext,
};

/** `memories[/<id>[/retire]]`. */
export async function memoriesRoute(
  ctx: RepoContext,
  method: string,
  id: string | undefined,
  sub: string | undefined,
  query: Json,
  body: () => Promise<Json>,
) {
  const ops = memoryOperations;
  if (!id && method === 'GET') return ops.git_memory_list(ctx, query);
  if (!id && method === 'POST') return ops.git_memory_add(ctx, await body());
  if (id && !sub && method === 'GET') return ops.git_memory_show(ctx, { ...query, id });
  if (id && sub === 'retire' && method === 'POST')
    return ops.git_memory_retire(ctx, { ...(await body().catch(() => ({}))), id });
  throw new ApiError('NOT_FOUND', 'Unknown API path');
}

/** `context/relevant` and `context/deliveries` (what a coding session was shown). */
export async function contextRoute(
  ctx: RepoContext,
  method: string,
  sub: string,
  query: Json,
  body: () => Promise<Json>,
) {
  if (sub === 'relevant' && method === 'GET') return relevantContext(ctx, query);
  if (sub === 'deliveries' && method === 'GET')
    return ctx.call({ op: 'repo_context_deliveries', session_id: query.session_id });
  if (sub === 'deliveries' && method === 'POST') {
    const b = await body();
    return ctx.call({
      op: 'repo_context_deliver',
      session_id: b.session_id,
      trigger: b.trigger,
      subject: b.subject ?? null,
      items: b.items,
      bytes: b.bytes,
    });
  }
  throw new ApiError('NOT_FOUND', 'Unknown API path');
}
