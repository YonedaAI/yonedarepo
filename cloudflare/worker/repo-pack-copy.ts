// Packs copied whole into the store of record: a retired mirror's history
// (repo-mirror-retire) and the commits pushed to a repository that has no mirror
// (repo-platform-store). The pack streams into a Rust receive session that resolves it as
// it arrives (files over 8 MiB spill straight into R2); then every commit, tree and blob it
// holds comes out framed and is written like a push's verified objects: a bundle per batch
// with PUSH_BUNDLES=on, else one R2 object each. Withheld blobs are never written.
import { bundlesOn, storeBundle } from './repo-bundles';
import { ReceiveSession } from './repo-git-sessions';
import { SpilledFiles } from './repo-large-files';
import { ApiError } from './repo-ops';
import { putRawBytes } from './repo-r2-writes';
import type { Env } from './types';

/** Object bytes per batch written (a bundle). */
const WRITE_BUDGET = 4 * 1024 * 1024;
/** Pack bytes fed to the session at once: what it holds of a spilled file's pack bytes. */
const FEED_BYTES = 1024 * 1024;
const WRITES = 64;
const KINDS = ['', 'commit', 'tree', 'blob'];

export type Frame = { id: string; kind: string; data: Uint8Array };

/** Splits `ReceiveSession.objects` frames: kind, 20-byte id, 4-byte length, content. */
export function framed(bytes: Uint8Array) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out: Frame[] = [];
  for (let at = 0; at < bytes.length; ) {
    const kind = KINDS[bytes[at]];
    const id = [...bytes.subarray(at + 1, at + 21)]
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
    const length = view.getUint32(at + 21);
    if (!kind || at + 25 + length > bytes.length)
      throw new ApiError('GIT_FAILED', 'Malformed object frame');
    out.push({ id, kind, data: bytes.subarray(at + 25, at + 25 + length) });
    at += 25 + length;
  }
  return out;
}

const pkt = (line: string) => `${(line.length + 4).toString(16).padStart(4, '0')}${line}`;

/** What precedes a bare pack for the session: one command naming `tip`, then a flush. */
export const copyHeader = (tip: string) =>
  new TextEncoder().encode(
    `${pkt(`${'0'.repeat(40)} ${tip} refs/yoneda/copy\0report-status\n`)}0000`,
  );

/** One pack on its way into the store of record. Close it in a `finally`. */
export class PackCopy {
  readonly #session = ReceiveSession.open();
  readonly #files: SpilledFiles;

  constructor(
    private readonly env: Env,
    private readonly repo: string,
    private readonly rawKey: (id: string) => string,
    private readonly withheld: ReadonlySet<string>,
  ) {
    this.#files = new SpilledFiles(env, repo, rawKey, (id) => withheld.has(id));
  }

  /** The next bytes: a receive-pack body (commands, then the pack), as they arrive. */
  async feed(chunk: Uint8Array) {
    for (let at = 0; at < chunk.length; at += FEED_BYTES) {
      this.#session.feed(chunk.subarray(at, at + FEED_BYTES));
      // Spilled files' content, the pack resuming while it waited for it to be taken.
      for (let paused = true; paused; ) {
        const frames = this.#session.spilled();
        paused = frames[0] === 1;
        await this.#files.take(frames.subarray(1));
        if (paused) this.#session.feed(new Uint8Array());
      }
    }
  }

  /** Checks the pack whole and writes its objects; answers the refs its commands named
   * and how many objects it holds (withheld ones not counted). */
  async store(): Promise<{ refs: string[]; objects: number }> {
    this.#session.call({ op: 'finish' });
    const { commands } = this.#session.call({ op: 'commands' });
    const { objects } = this.#session.call({ op: 'copy', skip: [...this.withheld] });
    const bundled = bundlesOn(this.env);
    for (let frames = this.#session.objects(WRITE_BUDGET); frames.length > 0; ) {
      const batch = framed(frames);
      if (bundled) await storeBundle(this.env, this.repo, frames, batch);
      else
        for (let i = 0; i < batch.length; i += WRITES)
          await putRawBytes(this.env, this.rawKey, batch.slice(i, i + WRITES));
      frames = this.#session.objects(WRITE_BUDGET);
    }
    return { refs: commands.map((c: { ref: string }) => c.ref), objects };
  }

  async close() {
    this.#session.close();
    await this.#files.abort();
  }
}
