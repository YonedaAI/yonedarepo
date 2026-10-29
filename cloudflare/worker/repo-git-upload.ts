// `git clone`/`fetch` over HTTPS (upload-pack). The authority names the commits the client
// lacks (`repo_git_walk`, from its wants and haves); a Rust session diffs each against its
// first parent to list the trees and files it introduced, then writes an undeltified pack
// entry by entry while blobs and commits are read from the store of record, so the pack
// streams out (on side-band when asked) and is never held whole. Refs are served from the
// log, so a fetch never sees Git projection lag. This is protocol version 0; version 2
// (partial and shallow clones) is `repo-git-v2.ts`, which shares the pack stream.

import { transient } from './durable';
import type { ReadStats, Wanted } from './repo-bundles';
import { compute } from './repo-compute';
import { rawObjects, SeenTrees, treesFor } from './repo-git-objects';
import { PackWriter, packCacheOn, packKey, storedPack } from './repo-pack-cache';
import {
  concat,
  end,
  failed,
  PackStats,
  RESULT,
  Storing,
  sendStored,
  sideBand,
} from './repo-pack-stream';

type Read = Wanted & { data: Uint8Array | null };

import { UploadSession } from './repo-git-sessions';
import { fromBase64, type RepoObjects, toBase64 } from './repo-objects';
import { ApiError, type Json, type RepoContext } from './repo-ops';
import { quarantined } from './repo-quarantine-guard';
import { timed } from './repo-timing';

export const REQUEST_BYTES = 8 * 1024 * 1024;
export { PackStats, RESULT };

const WALK_ROUNDS = 64;
/** Commits read while the walk runs, at most (each is held until the pack is written). */
const EARLY_COMMITS = 20_000;
/** Pack bytes gathered before they are sent (one side-band packet at most). */
export const CHUNK = 65515;

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
  const full = request.haves.length === 0;
  return sendPack(ack, () => UploadSession.open(walk), objects, band, stats, commits, {
    full,
    wants: request.wants,
  });
}

/** What a fetch asked for: every object its `wants` reach (`full`: no haves, filter or
 * depth), whose pack may then come from or go to the store (repo-pack-cache). */
export type Asked = { full: boolean; wants: string[] };

/** `head`, then the pack the session lists, on side-band `band` (none when 0) and ending
 * with a flush when banded. A failure before the pack starts is an ERR line after `head`
 * (Git prints it as `remote error: <message>`); an overloaded authority is rethrown, so Git
 * gets an HTTP 503 it can retry. A full clone's pack is streamed from the store when held
 * there, else stored as it streams (PACK_CACHE=on); the session is opened only to build.
 * A pack that would carry a quarantined blob is never started: the ERR names the blob
 * (and its path), rather than a pack Git finds incomplete. */
export async function sendPack(
  head: Uint8Array,
  open: () => UploadSession,
  objects: RepoObjects,
  band: number,
  stats?: PackStats,
  commits: string[] = [],
  asked?: Asked,
): Promise<Response> {
  let writer: PackWriter | undefined;
  // A stored pack carries every blob: never served or stored while any is withheld.
  if (asked?.full && packCacheOn(objects.env) && !(await objects.withholdsAny())) {
    const key = await packKey(objects.repo, asked.wants);
    const stored = await timed('git.pack_cached', () => storedPack(objects.env, key));
    if (stored) return sendStored(head, stored.body, band, stats);
    writer = new PackWriter(objects.env, objects.repo, key);
    if (stats) stats.cache = 'miss';
  }
  const session = open();
  let listed: Json;
  // The commits the walk names are read while their trees are walked.
  const early: Promise<Read[]> =
    commits.length <= EARLY_COMMITS
      ? readWhole(
          objects,
          commits.map((id) => ({ id, kind: 'commit' })),
          stats?.reads,
        )
      : Promise.resolve([]);
  early.catch(() => {});
  try {
    const started = performance.now();
    listed = await enumerate(session, objects, stats?.walkReads);
    if (stats) stats.walk = performance.now() - started;
    const blobs = (listed.fetch as Wanted[]).filter((w) => w.kind === 'blob').map((w) => w.id);
    const [held] = await objects.withheldAmong(blobs);
    if (held) throw quarantined(held[0], held[1]);
  } catch (e: any) {
    session.close();
    if (transient(e)) throw e;
    return errLine(head, e);
  }
  const chunks = packChunks(session, objects, listed, early, stats);
  const store = new Storing(writer, stats);
  const out = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(head);
    },
    async pull(controller) {
      try {
        const next = await chunks.next();
        if (next.done) {
          await store.finish();
          end(controller, band, stats);
        } else {
          await store.add(next.value);
          controller.enqueue(band ? sideBand(1, next.value, band) : next.value);
        }
      } catch (e: any) {
        await store.abort();
        failed(controller, band, e);
      }
    },
    async cancel() {
      await store.abort();
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
export async function enumerate(session: UploadSession, objects: RepoObjects, stats?: ReadStats) {
  const seen = new SeenTrees();
  let step = session.step({});
  for (let round = 0; step.need_trees; round++) {
    if (round >= WALK_ROUNDS)
      throw new ApiError('INVALID_INPUT', 'Directories are nested too deeply');
    const trees = await treesFor(objects, step.need_trees as string[], undefined, seen, stats);
    step = session.step({ trees });
  }
  return step;
}

/** `wanted` read whole (`rawObjects`). */
async function readWhole(objects: RepoObjects, wanted: Wanted[], stats?: ReadStats) {
  const read: Read[] = [];
  for await (const group of rawObjects(objects, wanted, stats)) read.push(...group);
  return read;
}

/** The pack, in pieces of about `CHUNK` bytes: header, trees and tag objects (from the
 * session), then the commits read `early`, then the other commits and blobs read in
 * groups (`rawObjects`), then the trailer. Closes the session. */
async function* packChunks(
  session: UploadSession,
  objects: RepoObjects,
  listed: Json,
  early: Promise<Read[]>,
  stats?: PackStats,
) {
  try {
    let pending: Uint8Array[] = [session.start()];
    let size = pending[0].length;
    const add = function* (entry: Uint8Array) {
      stats?.sent(entry);
      pending.push(entry);
      size += entry.length;
      if (size >= CHUNK) {
        yield concat(pending);
        pending = [];
        size = 0;
      }
    };
    const write = function* (group: Read[]) {
      for (const { id, kind, data } of group) {
        if (!data)
          throw new ApiError(
            'NOT_FOUND',
            kind === 'commit'
              ? `Commit ${id} is held only as imported history, which HTTPS does not serve yet; use git-remote-yoneda`
              : `${kind} ${id} is missing from the object store`,
          );
        if (stats) stats.raw += data.length;
        yield* add(session.entry(kind, id, data));
      }
    };
    for (const id of listed.trees as string[]) yield* add(session.entry('tree', id));
    // Annotated tag objects travel with the walk.
    for (const id of (listed.tags ?? []) as string[]) yield* add(session.entry('tag', id));
    let asked = performance.now();
    const ahead = await early;
    if (stats) stats.waited += performance.now() - asked;
    yield* write(ahead);
    const sent = new Set(ahead.map((o) => o.id));
    asked = performance.now();
    const rest = (listed.fetch as Wanted[]).filter((w) => !sent.has(w.id));
    for await (const group of rawObjects(objects, rest, stats?.reads)) {
      if (stats) stats.waited += performance.now() - asked;
      yield* write(group);
      asked = performance.now();
    }
    pending.push(session.finish());
    yield concat(pending);
  } finally {
    session.close();
  }
}
