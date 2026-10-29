// Large files: blobs over SPILL_BYTES (8 MiB) up to the 100 MiB per-file limit (GitHub's
// block; over 50 MiB a push is warned, as GitHub warns). The isolate has 128 MB in all and
// Rust compute holds several copies of what it is given, so such a blob is never held
// whole: a push's pack hands its content out as it inflates (the Rust session hashes it),
// and it streams into R2 as its own raw object at `git/<id>`, the store of record; packs,
// `/objects` downloads and fork copies stream it back out. R2 has no rename, so an upload
// goes to a temporary key first (the id is known only once the last byte hashed) and is
// streamed to its id: twice the bytes through R2, once per pushed file.

import { compute } from './repo-compute';
import { PackStream } from './repo-git-sessions';
import { ApiError, type Json } from './repo-ops';
import { R2Parts } from './repo-r2-parts';
import { fromBase64 } from './repo-stores';
import type { Env } from './types';

export const SPILL_BYTES = 8 * 1024 * 1024;
export const WARN_BYTES = 50 * 1024 * 1024;

/** A large blob in the store of record, not read: its size and body. */
export type LargeBody = { large: true; size: number; body: ReadableStream<Uint8Array> };
export const isLarge = (value: unknown): value is LargeBody =>
  typeof value === 'object' && value !== null && (value as LargeBody).large === true;

/** A large blob refused where it would be held whole (JSON reads, compute); its size in
 * `details` lets a reader serve a stub instead. */
export const tooLarge = (id: string, size: number) =>
  new ApiError(
    'TOO_LARGE',
    `File ${id} is ${(size / 1048576).toFixed(1)} MiB; download it with GET /objects/${id}`,
    { size },
  );

/** `stored` (an R2 read of a raw object) as a stream when large, else null. */
export function largeBody(stored: R2ObjectBody): LargeBody | null {
  return stored.size > SPILL_BYTES ? { large: true, size: stored.size, body: stored.body } : null;
}

/** Writes `body` (`size` bytes) to `key` as a raw blob, streaming. */
export async function putLarge(
  env: Env,
  key: string,
  size: number,
  body: ReadableStream<Uint8Array>,
) {
  const { readable, writable } = new FixedLengthStream(size);
  const [, written] = await Promise.all([
    body.pipeTo(writable),
    env.OBJECTS.put(key, readable, { customMetadata: { kind: 'blob' } }),
  ]);
  if (!written) throw new ApiError('INTERNAL', `Writing ${key} failed`);
}

/**
 * The files a push spills (`ReceiveSession.spilled` frames: 1 and an 8-byte size, 2 and a
 * 4-byte length and bytes, 3 and the 20-byte id), each written to R2 as it arrives and
 * moved to its raw key once its id is verified. `stored` lists them with their sizes.
 */
export class SpilledFiles {
  readonly stored: { id: string; size: number }[] = [];
  #current: R2Parts | null = null;
  #count = 0;

  constructor(
    private readonly env: Env,
    private readonly repo: string,
    private readonly rawKey: (id: string) => string,
  ) {}

  /** Takes `frames`; answers once every byte is on its way to R2. */
  async take(frames: Uint8Array) {
    const view = new DataView(frames.buffer, frames.byteOffset, frames.byteLength);
    for (let at = 0; at < frames.length; ) {
      const type = frames[at];
      if (type === 1) {
        await this.abort();
        const key = `platform/v1/${this.repo}/incoming/${crypto.randomUUID()}-${this.#count++}`;
        this.#current = new R2Parts(this.env, key);
        at += 9;
      } else if (type === 2) {
        const length = view.getUint32(at + 1);
        await this.#parts().add(frames.subarray(at + 5, at + 5 + length));
        at += 5 + length;
      } else if (type === 3) {
        const id = [...frames.subarray(at + 1, at + 21)]
          .map((b) => b.toString(16).padStart(2, '0'))
          .join('');
        await this.#store(id);
        at += 21;
      } else throw new ApiError('GIT_FAILED', 'Malformed spilled file frame');
    }
  }

  #parts() {
    if (!this.#current) throw new ApiError('GIT_FAILED', 'Spilled file content without a start');
    return this.#current;
  }

  async #store(id: string) {
    const parts = this.#parts();
    this.#current = null;
    await parts.finish();
    try {
      const temp = await this.env.OBJECTS.get(parts.key);
      if (!temp) throw new ApiError('INTERNAL', `Spilled file ${id} was not stored`);
      await putLarge(this.env, this.rawKey(id), parts.size, temp.body);
    } finally {
      await this.env.OBJECTS.delete(parts.key);
    }
    this.stored.push({ id, size: parts.size });
  }

  /** Drops a file still arriving (a failed push). */
  async abort() {
    const parts = this.#current;
    this.#current = null;
    await parts?.abort();
  }
}

/** Push report lines for stored files over WARN_BYTES, named by path where the pushed
 * commits' touches name them (GitHub's warning, with its advice). */
export function largeWarnings(stored: { id: string; size: number }[], commits: Json[]) {
  const paths = new Map<string, string>();
  for (const c of commits)
    for (const t of (c.touches ?? []) as Json[]) if (t.new_blob) paths.set(t.new_blob, t.path);
  return stored
    .filter((f) => f.size > WARN_BYTES)
    .map(
      (f) =>
        `warning: File ${paths.get(f.id) ?? f.id} is ${(f.size / 1048576).toFixed(2)} MB; this is larger than the recommended maximum file size of 50.00 MB. Consider Git Large File Storage (https://git-lfs.com).`,
    );
}

/** A large file's zlib stream for its pack entry, from its R2 body, never held whole: the
 * session hashes its content (checked against its id at `largeEnd`) and the bytes written
 * (into the pack's trailer). */
export async function* deflated(
  session: { largeData(content: Uint8Array, packed: Uint8Array): void },
  file: LargeBody,
) {
  const zlib = new CompressionStream('deflate');
  const writer = zlib.writable.getWriter();
  const none = new Uint8Array();
  const feeding = (async () => {
    for await (const chunk of file.body as unknown as AsyncIterable<Uint8Array>) {
      session.largeData(chunk, none);
      await writer.write(chunk);
    }
    await writer.close();
  })();
  feeding.catch(() => {});
  for await (const packed of zlib.readable as unknown as AsyncIterable<Uint8Array>) {
    session.largeData(none, packed);
    yield packed;
  }
  await feeding;
}

/**
 * A receive-pack request carrying large file `id` (`size` bytes, its R2 `body`) to an
 * object store, never held: the hidden ref of the file's carrier (a tree naming it and a
 * commit of that tree, `large_carrier`) and a pack of the file, streamed through
 * CompressionStream, then the carrier tree and commit. Answers the body and the carrier.
 */
export function largeReceivePack(id: string, size: number, body: ReadableStream<Uint8Array>) {
  const carrier = compute({ op: 'large_carrier', id });
  async function* pieces() {
    const pack = PackStream.open(3);
    try {
      yield fromBase64(carrier.head_b64);
      yield pack.header();
      yield pack.largeStart(id, size);
      yield* deflated(pack, { large: true, size, body });
      pack.largeEnd();
      yield pack.entry('tree', fromBase64(carrier.tree_b64));
      yield pack.entry('commit', fromBase64(carrier.commit_b64));
      yield pack.finish();
    } finally {
      pack.close();
    }
  }
  const out = pieces();
  return {
    carrier: String(carrier.commit),
    body: new ReadableStream<Uint8Array>({
      async pull(controller) {
        const next = await out.next();
        if (next.done) controller.close();
        else controller.enqueue(next.value);
      },
      async cancel() {
        await out.return(undefined);
      },
    }),
  };
}
