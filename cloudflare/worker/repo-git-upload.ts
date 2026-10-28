// `git clone`/`fetch` over HTTPS (upload-pack). The authority names the commits the client
// lacks (`repo_git_walk`, from its wants and haves); a Rust session diffs each against its
// first parent to list the trees and files it introduced, then writes an undeltified pack
// entry by entry while blobs and commits are read from the store of record, so the pack
// streams out (on side-band when asked) and is never held whole. Refs are served from the
// log, so a fetch never sees Git projection lag. This is protocol version 0; version 2
// (partial and shallow clones) is `repo-git-v2.ts`, which shares the pack stream.

import { transient } from './durable';
import { ReadStats, type Wanted } from './repo-bundles';
import { compute } from './repo-compute';
import { rawObjects, SeenTrees, treesFor } from './repo-git-objects';

type Read = Wanted & { data: Uint8Array | null };

import { UploadSession } from './repo-git-sessions';
import { fromBase64, type RepoObjects, toBase64 } from './repo-objects';
import { ApiError, type Json, type RepoContext } from './repo-ops';

export const RESULT = {
  'content-type': 'application/x-git-upload-pack-result',
  'cache-control': 'no-cache',
};
export const REQUEST_BYTES = 8 * 1024 * 1024;
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
  return sendPack(ack, UploadSession.open(walk), objects, band, stats, commits);
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
  stats?: PackStats,
  commits: string[] = [],
): Promise<Response> {
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
  } catch (e: any) {
    session.close();
    if (transient(e)) throw e;
    return errLine(head, e);
  }
  const chunks = packChunks(session, objects, listed, early, stats);
  const out = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(head);
    },
    async pull(controller) {
      try {
        const next = await chunks.next();
        if (next.done) {
          if (band && stats) controller.enqueue(sideBand(2, stats.line(), band));
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

/**
 * Where a fetch's time went, sent after the pack as a progress line (Git prints it as
 * `remote: yoneda-timing ...`) to a client that asks with `x-yoneda-timing: 1` (Git's
 * http.extraHeader). Workers clocks advance only across I/O, so these are waits: `walk`
 * (enumerating, before the pack), `read_wait` (the pack waiting on ranged reads) and
 * `stream` (the pack, start to end). CPU (hashing, zlib, deltas) is in the Worker's
 * metrics; `stream` less `read_wait` is mostly that and the client taking the bytes.
 */
export class PackStats {
  private readonly started = performance.now();
  walk = 0;
  waited = 0;
  raw = 0;
  /** The walk's ranged reads (trees) and the pack's (commits and files). */
  readonly walkReads = new ReadStats();
  readonly reads = new ReadStats();
  private entries = 0;
  private deltas = 0;
  private bytes = 0;

  /** Counts a pack entry (REF_DELTA entries are type 7). */
  sent(entry: Uint8Array) {
    this.entries++;
    this.bytes += entry.length;
    if (((entry[0] >> 4) & 7) === 7) this.deltas++;
  }

  line() {
    const ms = (n: number) => Math.round(n);
    const mib = (n: number) => (n / 1048576).toFixed(1);
    const fields = [
      `walk=${ms(this.walk)}ms`,
      `entries=${this.entries}`,
      `deltas=${this.deltas}`,
      `raw=${mib(this.raw)}MiB`,
      `sent=${mib(this.bytes)}MiB`,
      ...this.walkReads.fields('walk_'),
      ...this.reads.fields(),
      `read_wait=${ms(this.waited)}ms`,
      `stream=${ms(performance.now() - this.started - this.walk)}ms`,
    ];
    return new TextEncoder().encode(`yoneda-timing ${fields.join(' ')}\n`);
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
