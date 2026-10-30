// `git clone`/`fetch` over HTTPS (upload-pack). The authority names the commits the client
// lacks (`repo_git_walk`, from its wants and haves); a Rust session diffs each against its
// first parent to list the trees and files it introduced, then writes an undeltified pack
// entry by entry while blobs and commits are read from the store of record, so the pack
// streams out (on side-band when asked) and is never held whole. Refs are served from the
// log, so a fetch never sees Git projection lag. This is protocol version 0; version 2
// (partial and shallow clones) is `repo-git-v2.ts`, which shares the pack stream.

import { deferred } from './background';
import { transient } from './durable';
import { compute } from './repo-compute';
import { UploadSession, wasmMemoryBytes } from './repo-git-sessions';
import { fromBase64, type RepoObjects, toBase64 } from './repo-objects';
import { ApiError, type Json, type RepoContext } from './repo-ops';
import { type Built, buildPack } from './repo-pack-build';
import { type Fresh, PackWriter, packCacheOn, packKey, storedPack } from './repo-pack-cache';
import { handOff, minObjects } from './repo-pack-jobs';
import {
  CHUNK,
  concat,
  end,
  failed,
  logPack,
  PackStats,
  RESULT,
  Storing,
  sendStored,
  sideBand,
} from './repo-pack-stream';
import { timed } from './repo-timing';

export const REQUEST_BYTES = 8 * 1024 * 1024;
export { CHUNK, PackStats, RESULT };

/** A clone stores its pack only while this isolate's Wasm memory (which never shrinks; a
 * large push leaves 60-80 MiB) is at most this many MiB (PACK_STORE_WASM_MIB, default 48):
 * the stored parts and the clone's reads are JavaScript memory on top of it, under the
 * isolate's 128 MB. Otherwise a job stores it (repo-pack-jobs). */
const storeWasm = (objects: RepoObjects) =>
  Number(objects.env.PACK_STORE_WASM_MIB ?? 48) * 1024 * 1024;

export const pkt = (text: string) => {
  const bytes = new TextEncoder().encode(text);
  const head = new TextEncoder().encode((bytes.length + 4).toString(16).padStart(4, '0'));
  return concat([head, bytes]);
};

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
  stats?: PackStats,
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
  const commits = (walk.commits ?? []).map((c: Json) => String(c.commit));
  // Version 0 is served without filters or depth: with no haves, a full clone.
  const fresh: Fresh | undefined =
    request.haves.length === 0
      ? { wants: request.wants, omit_blobs: false, depth: null, deepen_relative: false }
      : undefined;
  return sendPack(ack, () => UploadSession.open(walk), objects, band, stats, commits, fresh);
}

/** `head`, then the pack the session lists, on side-band `band` (none when 0) and ending
 * with a flush when banded. A failure before the pack starts is an ERR line in place of
 * `head` (Git prints it as `remote error: <message>`; after `head`, which ends where the
 * pack's side-band packets begin, Git would read it as a packet of band 'E' and stop with
 * "bad band #69"); an overloaded authority is rethrown, so Git gets an HTTP 503 it can
 * retry. The pack of a fetch that has nothing (`fresh`: a clone,
 * partial or shallow, or a partial clone's checkout) is streamed from the store when held
 * there, else stored as it streams (PACK_CACHE=on), or by a job the fetch is handed to when
 * this isolate cannot store it. The session is opened only to build.
 * A pack that would carry a quarantined blob is never started: the ERR names the blob
 * (and its path), rather than a pack Git finds incomplete. */
export async function sendPack(
  head: Uint8Array,
  open: () => UploadSession,
  objects: RepoObjects,
  band: number,
  stats?: PackStats,
  commits: string[] = [],
  fresh?: Fresh,
): Promise<Response> {
  // Every built pack is logged; the client gets the timing line only when it asked.
  const tally = stats ?? new PackStats(false);
  let writer: PackWriter | undefined;
  let store = 'off';
  // A stored pack may carry any blob: never served or stored while any is withheld. Stored
  // packs are side-band packets of CHUNK (what version 2 always asks for).
  const cached =
    fresh && band === CHUNK && packCacheOn(objects.env) && !(await objects.withholdsAny());
  if (cached) {
    const key = await packKey(objects.repo, fresh);
    const stored = await timed('git.pack_cached', () => storedPack(objects.env, key));
    if (stored) return sendStored(head, stored, band, stats);
    tally.cache = 'miss';
    store = wasmMemoryBytes() <= storeWasm(objects) ? 'on' : 'skipped';
    if (store === 'on') writer = new PackWriter(objects.env, objects.repo, key);
  }
  let built: Built;
  try {
    built = await buildPack(open(), objects, commits, tally);
  } catch (e: any) {
    if (transient(e)) throw e;
    return errLine(new Uint8Array(), e);
  }
  const { count, chunks } = built;
  // A pack this isolate does not store, worth a build of its own, goes to a job.
  const worth = cached && count >= minObjects(objects.env);
  const hand = () => handOff(objects.env, objects.repo, fresh as Fresh);
  if (worth && store === 'skipped') {
    store = 'handed off';
    if (!deferred(hand)) await hand().catch((e) => console.warn(`pack hand-off failed: ${e}`));
  }
  logPack('git.pack.start', objects.repo, tally, { objects: count, store });
  const storing = new Storing(writer, tally, worth ? hand : undefined);
  const out = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(head);
    },
    async pull(controller) {
      try {
        const next = await chunks.next();
        if (next.done) {
          await storing.finish();
          logPack('git.pack.end', objects.repo, tally);
          end(controller, band, tally);
        } else {
          const sent = band ? sideBand(1, next.value, band) : next.value;
          storing.add(sent);
          controller.enqueue(sent);
        }
      } catch (e: any) {
        logPack('git.pack.failed', objects.repo, tally, {
          error: `${e?.code ?? 'ERROR'}: ${String(e?.message ?? e).slice(0, 300)}`,
        });
        await storing.abort();
        failed(controller, band, e);
      }
    },
    async cancel() {
      // The client went away (or the pack was cut off) before the end.
      logPack('git.pack.cancelled', objects.repo, tally);
      await storing.abort();
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
