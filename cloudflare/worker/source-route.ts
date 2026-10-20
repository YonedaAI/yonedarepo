import { error, response } from './http';
import { type SourceRevision, sourceError } from './source-contract';
import { preparedSourceView, sourceIndexBounded } from './source-index';
import { compareSourcePaths, sourceRepo } from './source-path';
import { sourceProvenance } from './source-provenance';
import { immutableSourceFile } from './source-storage';
import { ledger } from './storage';
import type { Env, Json, Principal } from './types';

const queryFields = ['published', 'candidate_id', 'path', 'cursor', 'limit', 'offset', 'q'];
async function selectedRevision(env: Env, repoId: string, principal: Principal, url: URL) {
  const repository = await ledger(env, repoId, {
    op: 'repository_status',
    _workspace: principal.workspace,
  });
  const id = url.searchParams.get('candidate_id');
  if ((id !== null) === (url.searchParams.get('published') === 'true'))
    throw sourceError('SOURCE_SCOPE', 'Select one recorded candidate or canonical publication');
  const candidate: Json | null = id
    ? await ledger(env, repoId, { op: 'candidate_record', id })
    : null;
  const revision = candidate?.revision ?? {
    repository: `${repository.remote.namespace}/${repository.remote.name}`,
    commit: repository.published_commit,
  };
  // The selector resolves authority in RepoDO; SDK supplies exact root metadata, never an input hash.
  const ref: SourceRevision = { ...revision, tree: candidate?.tree ?? '0'.repeat(40) };
  const artifacts = await sourceRepo(env, ref);
  const commit = await artifacts.readCommit(ref.commit);
  if (
    !commit ||
    commit.hash !== ref.commit ||
    (candidate?.tree && candidate.tree !== commit.treeHash)
  )
    throw sourceError('SOURCE_CHANGED', 'Recorded source commit differs');
  return { revision: { ...ref, tree: commit.treeHash }, candidate, repository };
}
const integer = (url: URL, key: string, fallback: number, max: number) => {
  const raw = url.searchParams.get(key);
  const value = raw === null ? fallback : Number(raw);
  if (!Number.isSafeInteger(value) || value < (key === 'limit' ? 1 : 0) || value > max)
    throw sourceError('SOURCE_LIMIT', 'Invalid source page or range');
  return value;
};

/** Parent invokes only after authentication; scope is rechecked before every SDK/cache access. */
export async function sourceRoute(
  req: Request,
  env: Env,
  principal: Principal,
  repoId: string,
): Promise<Response | null> {
  const url = new URL(req.url);
  const match =
    /^\/api\/repos\/[^/]+\/source\/(list|tree|file|search|diff|history|provenance)$/.exec(
      url.pathname,
    );
  if (!match) return null;
  try {
    if (req.method !== 'GET' || principal.role === 'agent')
      return error('FORBIDDEN', 'Owner source inspection is read only', 403);
    const seen = new Set<string>();
    for (const [key] of url.searchParams) {
      if (!queryFields.includes(key) || seen.has(key))
        throw sourceError('SOURCE_SCOPE', 'Unknown source selector');
      seen.add(key);
    }
    const { revision, candidate } = await selectedRevision(env, repoId, principal, url);
    const op = match[1];
    const identity = {
      version: 1,
      revision,
      candidate_id: candidate?.id ?? null,
      authority: 'git',
    };
    if (['list', 'tree', 'search', 'file'].includes(op)) {
      const prepared = await sourceIndexBounded(env, revision);
      if (prepared.state !== 'prepared')
        return response(
          {
            ...identity,
            preparation: prepared.state,
            retry_action: 'refresh_source',
            error: {
              code: prepared.state === 'failed' ? prepared.error_code : 'SOURCE_PREPARING',
              message:
                prepared.state === 'failed'
                  ? 'Immutable source metadata is unavailable'
                  : 'Immutable source metadata is preparing. Refresh source to advance the next bounded step.',
            },
          },
          409,
        );
    }
    if (op === 'file') {
      const read = await immutableSourceFile(
        env,
        revision,
        url.searchParams.get('path') ?? '',
        integer(url, 'offset', 0, Number.MAX_SAFE_INTEGER),
        integer(url, 'limit', 65536, 65536),
      );
      const metadata = JSON.parse(decodeURIComponent(read.headers.get('x-yoneda-source') ?? ''));
      read.headers.set(
        'x-yoneda-source',
        encodeURIComponent(JSON.stringify({ ...metadata, ...identity })),
      );
      return read;
    }
    if (op === 'history') {
      const artifacts = await sourceRepo(env, revision);
      const offset = integer(url, 'offset', 0, 10000);
      const limit = integer(url, 'limit', 50, 200);
      const items = await artifacts.log({ ref: revision.commit, limit, offset });
      return response({
        ...identity,
        items,
        next_cursor: items.length === limit ? String(offset + limit) : null,
      });
    }
    if (op === 'provenance')
      return response({
        ...identity,
        ...(await sourceProvenance(
          env,
          repoId,
          revision.commit,
          url.searchParams.get('path') ?? '',
          candidate,
        )),
      });
    if (op === 'diff')
      return response({
        ...identity,
        diff_digest: candidate?.diff_digest ?? null,
        available: candidate?.diff_digest != null,
        authority: 'recorded_diff',
      });
    const view = await preparedSourceView(env, revision);
    const prefix = url.searchParams.get('path') ?? '';
    const query = url.searchParams.get('q') ?? '';
    if (query.length > 200 || prefix.length > 512)
      throw sourceError('SOURCE_LIMIT', 'Source query exceeds limits');
    const cursor = url.searchParams.get('cursor');
    const limit = integer(url, 'limit', 50, 200);
    let files = view.files.filter(
      (file) =>
        (!prefix || file.path === prefix || file.path.startsWith(`${prefix}/`)) &&
        (op !== 'search' || file.path.toLowerCase().includes(query.toLowerCase())),
    );
    if (cursor) {
      const bound = JSON.parse(decodeURIComponent(cursor));
      if (
        bound.commit !== revision.commit ||
        bound.tree !== revision.tree ||
        bound.path !== prefix ||
        bound.q !== query ||
        bound.op !== op
      )
        throw sourceError(
          'VERSION_CONFLICT',
          'Source cursor belongs to another immutable selection',
        );
      files = files.filter((file) => compareSourcePaths(file.path, bound.after) > 0);
    }
    const items = files.slice(0, limit).map((file) => ({
      path: file.path,
      kind: 'file',
      exists: true,
      mode: file.mode,
      size: file.size,
      file_version: 0,
      blob_id: file.content.kind === 'git' ? file.content.blob : file.content.sha256,
    }));
    const more = files.length > limit;
    return response({
      ...identity,
      items,
      has_more: more,
      next_cursor: more
        ? encodeURIComponent(
            JSON.stringify({
              commit: revision.commit,
              tree: revision.tree,
              path: prefix,
              q: query,
              op,
              after: items.at(-1)?.path,
            }),
          )
        : null,
    });
  } catch (failure) {
    const known = failure as { code?: string; message: string };
    return error(
      known.code ?? 'SOURCE_FAILED',
      known.message,
      known.code === 'FORBIDDEN' ? 403 : 409,
    );
  }
}
