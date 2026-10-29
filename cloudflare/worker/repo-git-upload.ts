// `git clone`/`fetch` over HTTPS (upload-pack). The authority names the commits the client
// lacks (`repo_git_walk`, from its wants and haves); a Rust session diffs each against its
// first parent to list the trees and files it introduced, then writes an undeltified pack
// entry by entry while blobs and commits are read from the store of record, so the pack
// streams out (on side-band when asked) and is never held whole. Refs are served from the
// log, so a fetch never sees Git projection lag. This is protocol version 0; version 2
// (partial and shallow clones) is `repo-git-v2.ts`, which shares the pack stream.

import { transient } from './durable';
import { holdsBundles, type ReadStats, type Wanted } from './repo-bundles';
import { compute } from './repo-compute';
import {
  enumerate,
  FETCH_READS,
  overBudget,
  ReadBudget,
  rawObjects,
  SeenTrees,
  waves,
} from './repo-git-objects';
import { deflated, isLarge, type LargeBody } from './repo-large-files';
import { PackWriter, packCacheOn, packKey, storedPack } from './repo-pack-cache';
import {
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

type Read = Wanted & { data: Uint8Array | LargeBody | null };

import { UploadSession, wasmMemoryBytes } from './repo-git-sessions';
import { fromBase64, type RepoObjects, toBase64 } from './repo-objects';
import { ApiError, type Json, type RepoContext } from './repo-ops';
import { quarantined } from './repo-quarantine-guard';
import { timed } from './repo-timing';

export const REQUEST_BYTES = 8 * 1024 * 1024;
export { PackStats, RESULT };

/** Commits read while the walk runs, at most (each is held until the pack is written). */
const EARLY_COMMITS = 20_000;
/** Time one pack may take to stream (the clock moves with its reads and the client). */
const PACK_MS = 15 * 60_000;
/** Pack bytes gathered before they are sent (one side-band packet at most). */
export const CHUNK = 65515;
/** A clone stores its pack only while this isolate's Wasm memory (which never shrinks; a
 * large push leaves 60-80 MiB) is at most this: the stored parts and the clone's reads are
 * JavaScript memory on top of it, under the isolate's 128 MB. The next clone stores it. */
const STORE_WASM = 48 * 1024 * 1024;

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
  // Every built pack is logged; the client gets the timing line only when it asked.
  const tally = stats ?? new PackStats(false);
  let writer: PackWriter | undefined;
  let store = 'off';
  // A stored pack carries every blob: never served or stored while any is withheld. Stored
  // packs are side-band packets of CHUNK (what version 2 always asks for).
  if (
    asked?.full &&
    band === CHUNK &&
    packCacheOn(objects.env) &&
    !(await objects.withholdsAny())
  ) {
    const key = await packKey(objects.repo, asked.wants);
    const stored = await timed('git.pack_cached', () => storedPack(objects.env, key));
    if (stored) return sendStored(head, stored, band, stats);
    tally.cache = 'miss';
    store = wasmMemoryBytes() <= STORE_WASM ? 'on' : 'skipped';
    if (store === 'on') writer = new PackWriter(objects.env, objects.repo, key);
  }
  const session = open();
  const seen = new SeenTrees(commits.length);
  const budget = new ReadBudget();
  // The commits the walk names are read while their trees are walked.
  const early: Promise<Read[]> =
    commits.length <= EARLY_COMMITS
      ? readWhole(
          objects,
          commits.map((id) => ({ id, kind: 'commit' })),
          tally.reads,
          budget,
        )
      : Promise.resolve([]);
  early.catch(() => {});
  let count = 0;
  try {
    const started = performance.now();
    ({ count } = await enumerate(session, objects, tally.walkReads, seen));
    tally.walk = performance.now() - started;
    // Without bundles every object is a read of its own: refused before the pack starts.
    if (count > FETCH_READS && !holdsBundles(objects.repo))
      throw overBudget(`${count} objects read one at a time`);
    // So is a pack that would carry a withheld blob (the counting pass saw every id).
    const withheld = await objects.withheldAll();
    const [held] = withheld.size ? session.holds([...withheld.keys()]) : [];
    if (held) throw quarantined(held, withheld.get(held) ?? null);
  } catch (e: any) {
    session.close();
    if (transient(e)) throw e;
    return errLine(head, e);
  }
  logPack('git.pack.start', objects.repo, tally, { objects: count, store });
  const chunks = packChunks(session, objects, seen, early, budget, tally);
  const storing = new Storing(writer, tally);
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

/** `wanted` read whole (`rawObjects`). */
async function readWhole(
  objects: RepoObjects,
  wanted: Wanted[],
  stats?: ReadStats,
  budget?: ReadBudget,
) {
  const read: Read[] = [];
  for await (const group of rawObjects(objects, wanted, stats, budget)) read.push(...group);
  return read;
}

/** The pack, in pieces of about `CHUNK` bytes: header, then wave by wave (`waves`) its
 * trees from the session, its commits read `early`, its other commits and blobs read in
 * groups (`rawObjects`), then the trailer. Closes the session. */
async function* packChunks(
  session: UploadSession,
  objects: RepoObjects,
  seen: SeenTrees,
  early: Promise<Read[]>,
  budget: ReadBudget,
  stats?: PackStats,
) {
  try {
    let pending: Uint8Array[] = [session.start()];
    let size = pending[0].length;
    /** Pack bytes, sent once about `CHUNK` gathered. */
    const push = function* (bytes: Uint8Array) {
      pending.push(bytes);
      size += bytes.length;
      if (size >= CHUNK) {
        yield concat(pending);
        pending = [];
        size = 0;
      }
    };
    const add = function* (entry: Uint8Array) {
      stats?.sent(entry);
      yield* push(entry);
    };
    const write = async function* (group: Read[]) {
      for (const { id, kind, data } of group) {
        if (!data)
          throw new ApiError(
            'NOT_FOUND',
            kind === 'commit'
              ? `Commit ${id} is held only as imported history, which HTTPS does not serve yet; use git-remote-yoneda`
              : `${kind} ${id} is missing from the object store`,
          );
        if (isLarge(data)) {
          if (stats) stats.raw += data.size;
          yield* add(session.largeStart(id, data.size));
          for await (const packed of deflated(session, data)) {
            stats?.streamed(packed.length);
            yield* push(packed);
          }
          session.largeEnd();
          continue;
        }
        if (stats) stats.raw += data.length;
        yield* add(session.entry(kind, id, data));
      }
    };
    const began = performance.now();
    let asked = began;
    const ahead = new Map((await early).map((o) => [o.id, o]));
    if (stats) stats.waited += performance.now() - asked;
    // A wave at a time: its trees (held by the session), its commits read ahead, then its
    // other commits and files read in groups; tag objects travel with the last.
    for await (const wave of waves(session, objects, seen, stats?.walkReads)) {
      for (const id of wave.trees) yield* add(session.entry('tree', id));
      for (const id of wave.tags ?? []) yield* add(session.entry('tag', id));
      yield* write(wave.fetch.flatMap((w) => ahead.get(w.id) ?? []));
      const rest = wave.fetch.filter((w) => !ahead.delete(w.id));
      asked = performance.now();
      for await (const group of rawObjects(objects, rest, stats?.reads, budget)) {
        if (stats) stats.waited += performance.now() - asked;
        yield* write(group);
        asked = performance.now();
        // Fails as Git shows it (side-band), never a pack cut short in silence.
        if (asked - began > PACK_MS) throw overBudget(`more than ${PACK_MS / 60_000} minutes`);
      }
    }
    pending.push(session.finish());
    yield concat(pending);
  } finally {
    session.close();
  }
}
