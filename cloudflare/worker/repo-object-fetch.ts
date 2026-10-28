// Batch, resumable object fetch (Scion GetObjects, `POST /objects`) and the download of one
// large blob's bytes (`GET /objects/<id>`). A JSON page holds objects base64-encoded, so a
// blob of many megabytes costs several copies of itself in the isolate's memory: a clone of a
// history with large files (claude-code's 16 MiB demo.gif, several versions) ended 503 on
// exceeded resources. A client that asks with `large: true` gets such blobs as a stub
// (`{id, kind, size, large}`) and downloads each one's bytes on its own request instead.
import { decide, outside } from './repo-grants';
import { guardInherited } from './repo-inherit';
import { toBase64 } from './repo-objects';
import { ApiError, type Json, type RepoContext, SHA, walk } from './repo-ops';

const OBJECT_BUDGET = 8 * 1024 * 1024;
/** Blobs above this many bytes come as stubs to a client that downloads them separately. */
export const LARGE_BLOB = 2 * 1024 * 1024;
const OBJECT_KINDS = ['tree', 'blob', 'commit'];

/**
 * A path-restricted caller may fetch only objects it can name by path inside its grant at
 * a commit (no lookups by bare id, which would be a content oracle). Commit objects carry
 * only ids and are allowed.
 */
async function authorizeObjects(ctx: RepoContext, wanted: Json[], commitId: unknown) {
  if (!SHA.test(String(commitId ?? '')))
    throw new ApiError('FORBIDDEN', 'Path-restricted callers fetch objects by commit and path');
  const where = await ctx.call({ op: 'repo_commit', commit: commitId });
  const objects = await ctx.objects();
  for (const object of wanted) {
    if (object.kind === 'commit') continue;
    const path = String(object.path ?? '');
    if (!path || !(await decide(ctx, [path])).paths[0]) throw outside();
    const entry = await walk(objects, where.tree, path).catch(() => null);
    const kind = entry?.type === 'tree' ? 'tree' : 'blob';
    if (!entry || entry.id !== object.id || kind !== object.kind) throw outside();
  }
}

/**
 * Immutable objects by id and kind, in request order, up to a response budget. `next`
 * resumes after the last object served, so an interrupted client never refetches what it
 * already has. With `large`, blobs over `LARGE_BLOB` are stubs (see the header).
 */
export async function getObjects(ctx: RepoContext, args: Json) {
  const wanted = args.objects;
  if (
    !Array.isArray(wanted) ||
    wanted.length === 0 ||
    wanted.length > 10_000 ||
    !wanted.every((o) => SHA.test(o?.id) && OBJECT_KINDS.includes(o?.kind))
  )
    throw new ApiError('INVALID_INPUT', 'objects must be 1-10000 {id, kind} entries');
  const start = Number(args.after ?? 0);
  if (!Number.isSafeInteger(start) || start < 0 || start > wanted.length)
    throw new ApiError('INVALID_INPUT', 'after is outside the request');
  const objects = await ctx.objects();
  // Ids named by the caller: a fork serves inherited ones only to readers of its parent.
  guardInherited(ctx, objects);
  const grant = await decide(ctx, []);
  if (grant.restricted) await authorizeObjects(ctx, wanted, args.commit);
  // `raw`: commits as their exact Git content (`data_b64`) from the store of record, so a
  // client writes the platform's commit byte for byte. A commit only the object store
  // holds (imported history) keeps the tree-and-parents form. Path-restricted callers get
  // that form too: a message may name paths outside their grant.
  const raw = args.raw === true && !grant.restricted;
  const large = args.large === true;
  /** A blob as served: inline, or a stub the client downloads (never base64 of its bytes). */
  const blob = async (id: string) => {
    const bytes = await objects.blob(id);
    return large && bytes.length > LARGE_BLOB
      ? { id, kind: 'blob', size: bytes.length, large: true }
      : { id, kind: 'blob', data_b64: toBase64(bytes) };
  };
  const served: Json[] = [];
  const missing: string[] = [];
  let bytes = 0;
  let index = start;
  while (index < wanted.length) {
    const batch = wanted.slice(index, index + 16);
    const commits = raw ? batch.filter((o: Json) => o.kind === 'commit') : [];
    const exact = new Map(
      (commits.length ? await objects.raw(commits) : [])
        .filter((o) => o.kind === 'commit')
        .map((o) => [o.id, o]),
    );
    const read = await Promise.all(
      batch.map((o: Json) =>
        o.kind === 'commit' && exact.has(o.id)
          ? exact.get(o.id)
          : (o.kind === 'blob' ? blob(o.id) : objects.object(o.id, o.kind)).catch((e) => {
              if (e?.code === 'NOT_FOUND') return null;
              throw e;
            }),
      ),
    );
    let stop = false;
    for (const [offset, object] of read.entries()) {
      if (!object) missing.push(batch[offset].id);
      else {
        // A blob's size is its base64 text; stringifying it would copy it once more.
        const text = (object as Json).data_b64;
        const size = typeof text === 'string' ? text.length + 96 : JSON.stringify(object).length;
        if (served.length > 0 && bytes + size > OBJECT_BUDGET) {
          stop = true;
          break;
        }
        bytes += size;
        served.push(object);
      }
      index++;
    }
    if (stop) break;
  }
  return {
    objects: served,
    missing,
    next: index < wanted.length ? index : null,
    tiers: objects.hits,
  };
}

/** `GET /repos/:id/objects/<id>` (`?commit=&path=` for a path-restricted caller): one blob's
 * bytes, for the stubs `getObjects` serves. */
export async function downloadBlob(ctx: RepoContext, id: string, query: URLSearchParams) {
  if (!SHA.test(id)) throw new ApiError('INVALID_INPUT', 'id must be a blob id');
  const objects = await ctx.objects();
  guardInherited(ctx, objects);
  if ((await decide(ctx, [])).restricted)
    await authorizeObjects(
      ctx,
      [{ id, kind: 'blob', path: query.get('path') }],
      query.get('commit'),
    );
  const bytes = await objects.blob(id).catch((e) => {
    throw e?.code === 'NOT_FOUND' ? new ApiError('NOT_FOUND', `No blob ${id}`) : e;
  });
  return new Response(bytes, {
    headers: {
      'content-type': 'application/octet-stream',
      'content-length': String(bytes.length),
      'x-yoneda-object': id,
      'cache-control': 'no-store',
    },
  });
}
