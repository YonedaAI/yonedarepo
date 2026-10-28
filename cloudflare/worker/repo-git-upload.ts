// `git clone`/`fetch` over HTTPS (upload-pack). The authority names the commits the client
// lacks (`repo_git_walk`, from its wants and haves); a Rust session diffs each against its
// first parent to list the trees and files it introduced, then writes an undeltified pack
// entry by entry while blobs and commits are read from the store of record, so the pack
// streams out (on side-band when asked) and is never held whole. Refs are served from the
// log, so a fetch never sees Git projection lag. This is protocol version 0; version 2
// (partial and shallow clones) is `repo-git-v2.ts`, which shares the pack stream.

import { transient } from './durable';
import { compute } from './repo-compute';
import { inBatches, rawObject, treeFor } from './repo-git-objects';
import { UploadSession } from './repo-git-sessions';
import { fromBase64, type RepoObjects, toBase64 } from './repo-objects';
import { ApiError, type Json, type RepoContext } from './repo-ops';

export const RESULT = {
  'content-type': 'application/x-git-upload-pack-result',
  'cache-control': 'no-cache',
};
export const REQUEST_BYTES = 8 * 1024 * 1024;
const WALK_ROUNDS = 64;
const READS = 32;
/** Pack bytes gathered before they are sent (one side-band packet at most). */
export const CHUNK = 65515;

export const pkt = (text: string) => {
  const bytes = new TextEncoder().encode(text);
  const head = new TextEncoder().encode((bytes.length + 4).toString(16).padStart(4, '0'));
  return concat([head, bytes]);
};

function concat(parts: Uint8Array[]) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

export async function readAll(body: ReadableStream<Uint8Array>, limit: number) {
  const parts: Uint8Array[] = [];
  let length = 0;
  for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) {
    length += chunk.length;
    if (length > limit) throw new ApiError('TOO_LARGE', 'The fetch request is too large');
    parts.push(chunk);
  }
  return concat(parts);
}

export async function uploadPack(
  ctx: RepoContext,
  objects: RepoObjects,
  body: ReadableStream<Uint8Array>,
): Promise<Response> {
  const request = compute({
    op: 'git_upload_request',
    body_b64: toBase64(await readAll(body, REQUEST_BYTES)),
  });
  const walk = await ctx.call({
    op: 'repo_git_walk',
    wants: request.wants,
    haves: request.haves,
    common_only: !request.done,
  });
  const caps: string[] = request.capabilities;
  const ack = fromBase64(
    compute({
      op: 'git_acknowledge',
      common: walk.common,
      done: request.done,
      detailed: caps.includes('multi_ack_detailed'),
    }).body_b64,
  );
  if (!request.done) return new Response(ack, { headers: RESULT });
  const band = caps.includes('side-band-64k') ? CHUNK : caps.includes('side-band') ? 995 : 0;
  return sendPack(ack, UploadSession.open(walk), objects, band);
}

/** `head`, then the pack the session lists, on side-band `band` (none when 0) and ending
 * with a flush when banded. A failure before the pack starts is an ERR line after `head`
 * (Git prints it as `remote error: <message>`); an overloaded authority is rethrown, so Git
 * gets an HTTP 503 it can retry. */
export async function sendPack(
  head: Uint8Array,
  session: UploadSession,
  objects: RepoObjects,
  band: number,
): Promise<Response> {
  let listed: Json;
  try {
    listed = await enumerate(session, objects);
  } catch (e: any) {
    session.close();
    if (transient(e)) throw e;
    return errLine(head, e);
  }
  const chunks = packChunks(session, objects, listed);
  const out = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(head);
    },
    async pull(controller) {
      try {
        const next = await chunks.next();
        if (next.done) {
          if (band) controller.enqueue(new TextEncoder().encode('0000'));
          controller.close();
        } else controller.enqueue(band ? sideBand(1, next.value, band) : next.value);
      } catch (e: any) {
        if (!band) return controller.error(e);
        const message = `${e?.code ?? 'ERROR'}: ${String(e?.message ?? e)}`.slice(0, 500);
        controller.enqueue(sideBand(3, new TextEncoder().encode(`${message}\n`), band));
        controller.close();
      }
    },
    async cancel() {
      await chunks.return(undefined);
    },
  });
  return new Response(out, { headers: RESULT });
}

/** `head` and an ERR line for `e`. */
export function errLine(head: Uint8Array, e: any) {
  const message = `${e?.code ?? 'ERROR'}: ${String(e?.message ?? e)}`.slice(0, 500);
  return new Response(concat([head, pkt(`ERR ${message}\n`)]), { headers: RESULT });
}

/** Lists what to send, reading the trees each commit's diff needs. */
async function enumerate(session: UploadSession, objects: RepoObjects) {
  let step = session.step({});
  for (let round = 0; step.need_trees; round++) {
    if (round >= WALK_ROUNDS)
      throw new ApiError('INVALID_INPUT', 'Directories are nested too deeply');
    const trees = await inBatches(step.need_trees as string[], READS, (id) => treeFor(objects, id));
    step = session.step({ trees });
  }
  return step;
}

/** The pack, in pieces of about `CHUNK` bytes: header, trees (from the session), then
 * blobs and commits read in batches, then the trailer. Closes the session. */
async function* packChunks(session: UploadSession, objects: RepoObjects, listed: Json) {
  try {
    let pending: Uint8Array[] = [session.start()];
    let size = pending[0].length;
    const add = function* (entry: Uint8Array) {
      pending.push(entry);
      size += entry.length;
      if (size >= CHUNK) {
        yield concat(pending);
        pending = [];
        size = 0;
      }
    };
    for (const id of listed.trees as string[]) yield* add(session.entry('tree', id));
    const fetch = listed.fetch as { id: string; kind: string }[];
    for (let i = 0; i < fetch.length; i += READS) {
      const batch = fetch.slice(i, i + READS);
      const read = await Promise.all(batch.map((o) => rawObject(objects, o.id, o.kind)));
      for (const [index, data] of read.entries()) {
        const { id, kind } = batch[index];
        if (!data)
          throw new ApiError(
            'NOT_FOUND',
            kind === 'commit'
              ? `Commit ${id} is held only as imported history, which HTTPS does not serve yet; use git-remote-yoneda`
              : `${kind} ${id} is missing from the object store`,
          );
        yield* add(session.entry(kind, id, data));
      }
    }
    pending.push(session.finish());
    yield concat(pending);
  } finally {
    session.close();
  }
}

/** `data` as side-band packets on `band`, each carrying at most `max` bytes. */
function sideBand(band: number, data: Uint8Array, max: number) {
  const parts: Uint8Array[] = [];
  for (let at = 0; at < data.length; at += max) {
    const piece = data.subarray(at, at + max);
    const head = new TextEncoder().encode((piece.length + 5).toString(16).padStart(4, '0'));
    parts.push(head, Uint8Array.of(band), piece);
  }
  return concat(parts);
}
