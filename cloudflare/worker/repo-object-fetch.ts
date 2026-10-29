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

/** Response bytes per page (base64 text for blobs, JSON otherwise). */
const OBJECT_BUDGET = 4 * 1024 * 1024;
/** Object bytes one page may read, stubs included: the page stops once past it. */
const READ_BUDGET = 24 * 1024 * 1024;
/** Objects read at once. */
const READ_WIDTH = 8;
/** Blobs above this many bytes come as stubs to a client that downloads them separately. */
export const LARGE_BLOB = 2 * 1024 * 1024;
const OBJECT_KINDS = ['tree', 'blob', 'commit'];
/**
 * A blob download answers with the whole blob, so it never stops mid-body; but a store read
 * that never settles would hold the answer back with the client's connection open and
 * silent, for as long as the client waits. Past `ms` the download is a retryable TIMEOUT
 * (503). Mutable only so tests can shorten it.
 */
export const DOWNLOAD_DEADLINE = { ms: 25_000 };

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
  const served: Json[] = [];
  const missing: string[] = [];
  let bytes = 0;
  let read = 0;
  let largest = 0;
  let index = start;
  let phase = 'read';
  const began = Date.now();
  /** One line per page (and per failure) in the Worker's logs: what the page cost. */
  const log = (event: string, extra: Json = {}) =>
    console.log(
      JSON.stringify({
        event,
        repo: ctx.repo,
        requested: wanted.length,
        after: start,
        index,
        served: served.length,
        missing: missing.length,
        bytes,
        read,
        largest,
        large,
        raw,
        ms: Date.now() - began,
        tiers: objects.hits,
        ...extra,
      }),
    );
  /** A blob as served: inline, or a stub the client downloads (never base64 of its bytes). */
  const blob = async (id: string) => {
    const content = await objects.blob(id);
    read += content.length;
    largest = Math.max(largest, content.length);
    return large && content.length > LARGE_BLOB
      ? { id, kind: 'blob', size: content.length, large: true }
      : { id, kind: 'blob', data_b64: toBase64(content) };
  };
  try {
    // A page ends at its response budget or once it has read `READ_BUDGET` object bytes.
    while (index < wanted.length && read < READ_BUDGET) {
      const batch = wanted.slice(index, index + READ_WIDTH);
      const commits = raw ? batch.filter((o: Json) => o.kind === 'commit') : [];
      phase = commits.length ? 'raw commits' : 'read';
      const exact = new Map(
        (commits.length ? await objects.raw(commits) : [])
          .filter((o) => o.kind === 'commit')
          .map((o) => [o.id, o]),
      );
      phase = 'read';
      const results = await Promise.all(
        batch.map((o: Json) =>
          o.kind === 'commit' && exact.has(o.id)
            ? exact.get(o.id)
            : (o.kind === 'blob' ? blob(o.id) : objects.object(o.id, o.kind)).catch((e) => {
                if (e?.code === 'NOT_FOUND') return null;
                throw e;
              }),
        ),
      );
      phase = 'serve';
      let stop = false;
      for (const [offset, object] of results.entries()) {
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
  } catch (e: any) {
    log('objects.failed', {
      phase,
      error: `${e?.code ?? 'ERROR'}: ${String(e?.message ?? e).slice(0, 300)}`,
    });
    throw e;
  }
  log('objects.page');
  return {
    objects: served,
    missing,
    next: index < wanted.length ? index : null,
    tiers: objects.hits,
  };
}

/** `GET /repos/:id/objects/<id>` (`?commit=&path=` for a path-restricted caller): one blob's
 * bytes, for the stubs `getObjects` serves. A single `Range: bytes=N-[M]` is honored (206),
 * so a client whose download was cut resumes from the bytes it has. */
export async function downloadBlob(
  ctx: RepoContext,
  id: string,
  query: URLSearchParams,
  range: string | null = null,
) {
  if (!SHA.test(id)) throw new ApiError('INVALID_INPUT', 'id must be a blob id');
  const objects = await ctx.objects();
  guardInherited(ctx, objects);
  if ((await decide(ctx, [])).restricted)
    await authorizeObjects(
      ctx,
      [{ id, kind: 'blob', path: query.get('path') }],
      query.get('commit'),
    );
  let timer: ReturnType<typeof setTimeout> | null = null;
  const late = new Promise<never>((_, refuse) => {
    timer = setTimeout(
      () =>
        refuse(
          new ApiError('TIMEOUT', `Reading blob ${id} took over ${DOWNLOAD_DEADLINE.ms} ms; retry`),
        ),
      DOWNLOAD_DEADLINE.ms,
    );
  });
  const read = Promise.race([objects.blob(id), late]).finally(() => clearTimeout(timer));
  const bytes = await read.catch((e) => {
    if (e?.code === 'NOT_FOUND') throw new ApiError('NOT_FOUND', `No blob ${id}`);
    console.log(
      JSON.stringify({
        event: 'objects.download_failed',
        repo: ctx.repo,
        id,
        error: `${e?.code ?? 'ERROR'}: ${String(e?.message ?? e).slice(0, 300)}`,
      }),
    );
    throw e;
  });
  const headers = {
    'content-type': 'application/octet-stream',
    'x-yoneda-object': id,
    'cache-control': 'no-store',
    'accept-ranges': 'bytes',
  };
  const span = byteRange(range, bytes.length);
  if (span === 'unsatisfiable')
    return new Response(null, {
      status: 416,
      headers: { ...headers, 'content-range': `bytes */${bytes.length}` },
    });
  if (!span)
    return new Response(bytes, { headers: { ...headers, 'content-length': String(bytes.length) } });
  const [first, last] = span;
  return new Response(bytes.subarray(first, last + 1), {
    status: 206,
    headers: {
      ...headers,
      'content-length': String(last + 1 - first),
      'content-range': `bytes ${first}-${last}/${bytes.length}`,
    },
  });
}

/** The inclusive span one `bytes=N-` or `bytes=N-M` range names in `size` bytes; null for no
 * range or one this endpoint serves whole (several spans, a suffix, malformed). */
function byteRange(header: string | null, size: number): [number, number] | 'unsatisfiable' | null {
  const match = /^bytes=(\d+)-(\d*)$/.exec(header?.trim() ?? '');
  if (!match) return null;
  const first = Number(match[1]);
  const last = match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
  if (!Number.isSafeInteger(first) || first >= size) return 'unsatisfiable';
  return last < first ? null : [first, last];
}
