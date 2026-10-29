// How a pack goes out: side-band packets, the closing timing line (PackStats), a failure
// midway, and the full-clone pack the store holds (repo-pack-cache), streamed as it is or
// copied into the store while a built one streams.

import { deferrer } from './background';
import { ReadStats } from './repo-bundles';
import type { PackWriter } from './repo-pack-cache';

export function concat(parts: Uint8Array[]) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

export const RESULT = {
  'content-type': 'application/x-git-upload-pack-result',
  'cache-control': 'no-cache',
};

/** The pack held in the store (already in side-band packets of `CHUNK`), piped after
 * `head` with no JavaScript between R2 and the client, then the timing line and flush. */
export function sendStored(
  head: Uint8Array,
  stored: R2ObjectBody,
  band: number,
  stats?: PackStats,
) {
  if (stats) stats.cache = 'hit';
  const { readable, writable } = new IdentityTransformStream();
  const write = async (bytes: Uint8Array) => {
    const writer = writable.getWriter();
    await writer.write(bytes);
    writer.releaseLock();
  };
  (async () => {
    await write(head);
    await stored.body.pipeTo(writable, { preventClose: true });
    stats?.streamed(stored.size);
    if (stats) await write(sideBand(2, stats.line(), band));
    await write(new TextEncoder().encode('0000'));
    await writable.close();
  })().catch((e) => writable.abort(e).catch(() => {}));
  return new Response(readable, { headers: RESULT });
}

/** A banded pack ends with the timing line (when asked) and a flush. */
export function end(
  controller: ReadableStreamDefaultController<Uint8Array>,
  band: number,
  stats?: PackStats,
) {
  if (band && stats) controller.enqueue(sideBand(2, stats.line(), band));
  if (band) controller.enqueue(new TextEncoder().encode('0000'));
  controller.close();
}

/** A pack that fails midway: an error on side-band 3 (Git prints it), else a broken body. */
export function failed(
  controller: ReadableStreamDefaultController<Uint8Array>,
  band: number,
  e: any,
) {
  if (!band) return controller.error(e);
  const message = `${e?.code ?? 'ERROR'}: ${String(e?.message ?? e)}`.slice(0, 500);
  controller.enqueue(sideBand(3, new TextEncoder().encode(`${message}\n`), band));
  controller.close();
}

/** Pack bytes waiting for the store before storing is given up: the client never waits
 * on R2 (a clone that outruns the store is served whole, its pack just not kept). */
const STORE_BACKLOG = 16 * 1024 * 1024;

/** Copies a built pack into the store (`writer`), if any, behind the response: `add`
 * never waits, and `finish` completes after the answer when the request lent waitUntil.
 * Storing is best effort: a failed or lagging write is dropped, never the clone. */
export class Storing {
  #queue: Promise<void> = Promise.resolve();
  #backlog = 0;
  readonly #defer = deferrer();

  constructor(
    private writer: PackWriter | undefined,
    private readonly stats?: PackStats,
  ) {}

  add(bytes: Uint8Array) {
    const writer = this.writer;
    if (!writer) return;
    if (this.#backlog + bytes.length > STORE_BACKLOG) {
      this.#drop('the store fell behind the clone');
      return;
    }
    this.#backlog += bytes.length;
    this.#queue = this.#queue.then(() =>
      writer.add(bytes).then(() => void (this.#backlog -= bytes.length)),
    );
    this.#queue.catch((e) => this.#drop(e?.message ?? e));
  }

  async finish() {
    const writer = this.writer;
    if (!writer) return;
    const queue = this.#queue;
    const work = async () => {
      await queue;
      if (this.writer !== writer) return;
      const kept = await writer.finish();
      if (kept && this.stats) this.stats.cache = 'stored';
    };
    if (this.#defer(work)) {
      if (this.stats) this.stats.cache = 'storing';
    } else await work().catch((e) => this.#drop(e?.message ?? e));
  }

  async abort() {
    const writer = this.writer;
    this.writer = undefined;
    await this.#queue.catch(() => {});
    await writer?.abort().catch(() => {});
  }

  #drop(why: string) {
    if (!this.writer) return;
    console.warn(`pack not stored: ${why}`);
    void this.abort();
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
  /** Whether the pack came from the store (`hit`), was stored (`stored`), or neither. */
  cache: 'off' | 'hit' | 'miss' | 'storing' | 'stored' = 'off';
  private entries = 0;
  private deltas = 0;
  private bytes = 0;

  /** Counts bytes of a stored pack streamed as they are. */
  streamed(bytes: number) {
    this.bytes += bytes;
  }

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
      `cache=${this.cache}`,
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
export function sideBand(band: number, data: Uint8Array, max: number) {
  const parts: Uint8Array[] = [];
  for (let at = 0; at < data.length; at += max) {
    const piece = data.subarray(at, at + max);
    const head = new TextEncoder().encode((piece.length + 5).toString(16).padStart(4, '0'));
    parts.push(head, Uint8Array.of(band), piece);
  }
  return concat(parts);
}
