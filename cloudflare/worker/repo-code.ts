// Code-aware platform operations: review classes for every recorded commit, symbols with
// handles, symbol edits that reject stale handles, and partitioned codemods that reduce
// to one commit. Parsing and classification run in Rust compute; results that depend
// only on content are cached by blob id.

import { compute } from './repo-compute';
import { searchSegments, withObjects } from './repo-derived';
import { toBase64 } from './repo-objects';
import { ApiError, caller, commit, type Json, RepoContext, target, walk } from './repo-ops';

const PLATFORM_AUTHOR = { name: 'YonedaRepo', email: 'commits@yonedarepo.invalid' };
const MAX_CLASSIFIED_FILES = 200;

/** Classifies a recorded commit's changes and records them as the platform classifier. */
export async function classifyCommit(ctx: RepoContext, sha: string, touches: Json[]) {
  const classifier = new RepoContext(
    ctx.env,
    ctx.repo,
    caller(ctx.env, ctx.repo, { _system: 'derive' }),
  );
  const changes = touches.map((t) => ({
    path: t.path,
    old: t.old_blob ?? null,
    new: t.new_blob ?? null,
  }));
  if (changes.length > MAX_CLASSIFIED_FILES)
    return classifier.call({
      op: 'repo_record_classes',
      commit: sha,
      overall: 'unknown',
      files: changes.map((c) => ({ path: c.path, class: 'unknown' })),
    });
  const result = await withObjects(classifier, { op: 'review_classes', changes });
  return classifier.call({
    op: 'repo_record_classes',
    commit: sha,
    overall: result.overall,
    files: result.files,
  });
}

async function fileAt(ctx: RepoContext, args: Json) {
  const where = await target(ctx, args.commit ?? args.ref, args.at);
  const objects = await ctx.objects();
  const path = String(args.path ?? '');
  const entry = await walk(objects, where.tree, path);
  if (!['blob', 'exec'].includes(entry.type))
    throw new ApiError('NOT_FOUND', `${path} is not a file`);
  return { where, path, id: entry.id, objects };
}

async function symbolTable(ctx: RepoContext, path: string, id: string) {
  const ext = path.includes('.') ? path.slice(path.lastIndexOf('.') + 1) : 'none';
  const key = `derived/v1/${ctx.repo}/symbols/v1/${ext}/${id}`;
  const cached = await ctx.env.OBJECTS.get(key);
  if (cached) return cached.json<Json>();
  const table = await withObjects(ctx, { op: 'symbols', path, id });
  await ctx.env.OBJECTS.put(key, JSON.stringify(table));
  return table;
}

const handleOf = (commitId: string, path: string, s: Json) => ({
  commit: commitId,
  path,
  symbol_path: s.symbol_path,
  start: s.start,
  end: s.end,
  digest: s.digest,
});

export async function listSymbols(ctx: RepoContext, args: Json) {
  const { where, path, id } = await fileAt(ctx, args);
  const table = await symbolTable(ctx, path, id);
  return {
    commit: where.commit,
    path,
    blob: id,
    supported: table.supported,
    ...(table.parse_error ? { parse_error: table.parse_error } : {}),
    symbols: (table.symbols as Json[]).map((s) => ({
      ...s,
      handle: handleOf(where.commit, path, s),
    })),
  };
}

export async function getSymbol(ctx: RepoContext, args: Json) {
  const name = String(args.symbol ?? args.name ?? '');
  const { where, path, id, objects } = await fileAt(ctx, args);
  const table = await symbolTable(ctx, path, id);
  const symbol =
    (table.symbols as Json[]).find((s) => s.symbol_path === name) ??
    (table.symbols as Json[]).find((s) => s.name === name);
  if (!symbol) throw new ApiError('NOT_FOUND', `${name} is not a symbol of ${path}`);
  const bytes = await objects.blob(id);
  return {
    ...symbol,
    source: new TextDecoder().decode(bytes.subarray(symbol.start, symbol.end)),
    handle: handleOf(where.commit, path, symbol),
  };
}

/** Replaces one symbol on the head of `ref`, creating (not landing) a commit. */
export async function editSymbol(ctx: RepoContext, args: Json) {
  const handle = args.handle;
  if (!handle?.path || !handle?.symbol_path || !handle?.digest)
    throw new ApiError('INVALID_INPUT', 'handle must come from symbol_get or symbol_list');
  const ref = String(args.ref ?? 'main');
  const { where, path, id } = await fileAt(ctx, { ref, path: handle.path });
  const edited = await withObjects(ctx, {
    op: 'symbol_edit',
    path,
    id,
    handle,
    replacement_b64: toBase64(new TextEncoder().encode(String(args.replacement ?? ''))),
  });
  return commit(ctx, await ctx.objects(), {
    parent: where.commit,
    base_version: where.version,
    changes: [{ path, content_b64: edited.content_b64, expect: edited.expect }],
    message: args.message ?? `Edit ${handle.symbol_path} in ${path}`,
    author: args.author ?? PLATFORM_AUTHOR,
    read_set: [path],
  });
}

/**
 * Literal find/replace across a branch, one partition at a time (each partition's
 * candidates come from its search segment), reduced into a single commit.
 */
export async function codemod(ctx: RepoContext, args: Json) {
  const find = String(args.find ?? '');
  if (find.length < 2) throw new ApiError('INVALID_INPUT', 'find must be at least 2 characters');
  const ref = String(args.ref ?? 'main');
  const where = await target(ctx, ref);
  const prefix = String(args.path ?? '');
  const objects = await ctx.objects();
  const { segments } = await searchSegments(ctx, where.tree);
  const perPartition = await Promise.all(
    segments.map(async (entry) => {
      if (entry.too_large)
        return { partition: entry.partition.prefix, skipped: true, changes: [] as Json[] };
      const { candidates } = compute({ op: 'search_segment', segment: entry.segment, query: find });
      const changes: Json[] = [];
      for (const file of candidates as Json[]) {
        if (!file.indexed || (prefix && !String(file.path).startsWith(prefix))) continue;
        const result = compute({
          op: 'replace_literal',
          id: file.id,
          find,
          replace: String(args.replace ?? ''),
          blobs: { [file.id]: toBase64(await objects.blob(file.id)) },
        });
        if (result.changed)
          changes.push({ path: file.path, content_b64: result.content_b64, expect: result.expect });
      }
      return { partition: entry.partition.prefix, changes };
    }),
  );
  const changes = perPartition.flatMap((p) => p.changes);
  if (changes.length === 0)
    return { changed: false, commit: null, partitions: perPartition.length };
  const made = await commit(ctx, objects, {
    parent: where.commit,
    base_version: where.version,
    changes,
    message: args.message ?? `Replace "${find}" with "${args.replace ?? ''}"`,
    author: args.author ?? PLATFORM_AUTHOR,
  });
  return { ...made, changed: true, files: changes.length, partitions: perPartition.length };
}
