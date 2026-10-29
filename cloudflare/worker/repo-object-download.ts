// The download of one large blob's bytes (`GET /objects/<id>`): the stubs `POST /objects`
// serves with `large` (repo-object-fetch.ts) are fetched here, whole or from a byte range.
// A file too large to hold (repo-large-files) streams from the store of record.

import { decide } from './repo-grants';
import { guardInherited } from './repo-inherit';
import { SPILL_BYTES } from './repo-large-files';
import { authorizeObjects } from './repo-object-fetch';
import type { RepoObjects } from './repo-objects';
import { ApiError, type RepoContext, SHA } from './repo-ops';

/**
 * A blob download answers with the whole blob, so it never stops mid-body; but a store read
 * that never settles would hold the answer back with the client's connection open and
 * silent, for as long as the client waits. Past `ms` the download is a retryable TIMEOUT
 * (503). Mutable only so tests can shorten it.
 */
export const DOWNLOAD_DEADLINE = { ms: 25_000 };

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
  // A large file streams from the store of record, never held (repo-large-files); a
  // withheld one is refused first, before any byte.
  const large = await largeDownload(objects, id, range);
  if (large) return large;
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

/** A large file's download (whole, or the one `range` asks for) streamed from the store of
 * record; null when `id` is not a large file there. A withheld blob is refused first. */
async function largeDownload(objects: RepoObjects, id: string, range: string | null) {
  await objects.refuse(id);
  const key = objects.rawKey(id);
  const head = await objects.env.OBJECTS.head(key);
  if (!head || head.size <= SPILL_BYTES) return null;
  const headers = {
    'content-type': 'application/octet-stream',
    'x-yoneda-object': id,
    'cache-control': 'no-store',
    'accept-ranges': 'bytes',
  };
  const span = byteRange(range, head.size);
  if (span === 'unsatisfiable')
    return new Response(null, {
      status: 416,
      headers: { ...headers, 'content-range': `bytes */${head.size}` },
    });
  const [first, last] = span ?? [0, head.size - 1];
  const stored = await objects.env.OBJECTS.get(key, {
    range: { offset: first, length: last + 1 - first },
  });
  if (!stored) throw new ApiError('NOT_FOUND', `No blob ${id}`);
  return new Response((stored as R2ObjectBody).body, {
    status: span ? 206 : 200,
    headers: {
      ...headers,
      'content-length': String(last + 1 - first),
      ...(span ? { 'content-range': `bytes ${first}-${last}/${head.size}` } : {}),
    },
  });
}
