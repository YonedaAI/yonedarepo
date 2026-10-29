// How a pack goes out: side-band packets, the closing timing line (PackStats), a failure
// midway, and the clone pack the store holds (repo-pack-cache), streamed as it is or copied
// into the store while a built one streams.

import { deferrer } from './background';
import { ReadStats } from './repo-bundles';
import { wasmMemoryBytes } from './repo-git-sessions';
import type { PackWriter } from './repo-pack-cache';

const MiB = 1024 * 1024;
/** Pack bytes gathered before they are sent (one side-band packet at most). */
export const CHUNK = 65515;

/** One log line per event of a built pack, with this isolate's Wasm memory (it only grows).
 * A pack cut off with its isolate (CPU or memory limit) logs `git.pack.start` and no end:
 * the invocation's outcome in the tail names the limit. */
export function logPack(event: string, repo: string, stats: PackStats, extra: object = {}) {
  const wasm_mib = Math.round(wasmMemoryBytes() / MiB);
  console.log(JSON.stringify({ event, repo, ...stats.summary(), wasm_mib, ...extra }));
}

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
    if (stats?.report) await write(sideBand(2, stats.line(), band));
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
  if (band && stats?.report) controller.enqueue(sideBand(2, stats.line(), band));
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

/** Copies a built pack into the store (`writer`), if any, behind the response: `add`
 * copies the bytes at once and never waits, and `finish` completes after the answer when
 * the request lent waitUntil. Storing holds three parts at most: a write that fails or
 * falls two parts behind the clone is dropped, never the clone, and `dropped` (a job then
 * builds the pack: repo-pack-jobs) runs behind the answer. */
export class Storing {
  readonly #defer = deferrer();

  constructor(
    private writer: PackWriter | undefined,
    private readonly stats?: PackStats,
    private readonly dropped?: () => Promise<unknown>,
  ) {}

  add(bytes: Uint8Array) {
    if (this.writer && !this.writer.offer(bytes)) this.#drop('the store fell behind the clone');
  }

  async finish() {
    const writer = this.writer;
    if (!writer) return;
    const work = async () => {
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
    await writer?.abort().catch(() => {});
  }

  #drop(why: string) {
    if (!this.writer) return;
    console.warn(`pack not stored: ${why}`);
    void this.abort();
    const dropped = this.dropped;
    if (dropped && !this.#defer(dropped))
      dropped().catch((e) => console.warn(`pack hand-off failed: ${e?.message ?? e}`));
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
  /** `report`: the client asked for the timing line; the server logs the pack either way. */
  constructor(readonly report = true) {}
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

  /** The pack's log fields (`logPack`). */
  summary() {
    return {
      cache: this.cache,
      entries: this.entries,
      sent_mib: Number((this.bytes / MiB).toFixed(1)),
      raw_mib: Number((this.raw / MiB).toFixed(1)),
      walk_ms: Math.round(this.walk),
      read_wait_ms: Math.round(this.waited),
      ms: Math.round(performance.now() - this.started),
    };
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
