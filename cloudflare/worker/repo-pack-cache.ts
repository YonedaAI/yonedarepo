// Full clones from a stored pack (PACK_CACHE=on). A full clone (no haves, filter or depth)
// gets every object reachable from its wants, so its pack depends on the wants alone. Built
// from bundles, a clone reads all of history raw (168 MiB for claude-code's 32 MiB pack)
// and deltas and compresses it in the Worker: 6-10 s live against GitHub's 1.6-1.9 s. The
// first such clone of a set of tips stores the pack while it streams; the next streams that
// one R2 object. Wants are still walked by the authority first, so a stored pack is served
// only for tips the client may fetch now (a force-push that dropped history leaves its old
// pack unreachable). Key: `derived/v1/<repo>/packs/v1/<sha256 of the sorted wants>.pack`.
import type { Env } from './types';

/** Bytes per multipart part (R2: every part but the last the same size, at least 5 MiB). */
export const PART = 8 * 1024 * 1024;
/** Smaller packs build quickly anyway: not stored. */
const MIN_STORED = 256 * 1024;
/** Stored packs kept per repository, most recent first; older ones are deleted. */
const KEPT = 4;

export const packCacheOn = (env: Env) => env.PACK_CACHE === 'on';
const prefix = (repo: string) => `derived/v1/${repo}/packs/v1/`;
const recentKey = (repo: string) => `${prefix(repo)}recent`;

/** Where the pack of a full clone wanting `wants` is stored. */
export async function packKey(repo: string, wants: string[]) {
  const sorted = [...new Set(wants)].sort().join('\n');
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(sorted));
  const name = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `${prefix(repo)}${name}.pack`;
}

/** The stored pack at `key`, or null. */
export const storedPack = (env: Env, key: string) => env.OBJECTS.get(key);

/**
 * Stores a pack as it streams: parts of `PART` bytes go up one at a time while the next
 * fills (at most two parts held), a pack under one part is one put at the end. Nothing is
 * visible until `finish`; `abort` (a failed or cancelled pack) leaves nothing behind.
 */
export class PackWriter {
  #parts: R2UploadedPart[] = [];
  #buffer: Uint8Array;
  #filled = 0;
  #total = 0;
  #upload?: Promise<R2MultipartUpload>;
  #uploading: Promise<void> = Promise.resolve();

  constructor(
    private readonly env: Env,
    private readonly repo: string,
    private readonly key: string,
    private readonly part = PART,
  ) {
    this.#buffer = new Uint8Array(part);
  }

  /** Adds `bytes`, waiting for an upload only when a second full part is ready. */
  async add(bytes: Uint8Array) {
    this.#total += bytes.length;
    for (let at = 0; at < bytes.length; ) {
      const take = Math.min(bytes.length - at, this.part - this.#filled);
      this.#buffer.set(bytes.subarray(at, at + take), this.#filled);
      this.#filled += take;
      at += take;
      if (this.#filled === this.part) await this.#send(this.#buffer);
    }
  }

  async #send(part: Uint8Array) {
    await this.#uploading;
    this.#upload ??= this.env.OBJECTS.createMultipartUpload(this.key);
    const upload = await this.#upload;
    const number = this.#parts.length + 1;
    const sending = upload.uploadPart(number, part);
    this.#uploading = sending.then((uploaded) => {
      this.#parts[number - 1] = uploaded;
    });
    this.#parts.length = number;
    this.#buffer = new Uint8Array(this.part);
    this.#filled = 0;
  }

  /** Completes the stored pack (unless it is too small to keep) and evicts old ones. */
  async finish() {
    const rest = this.#buffer.subarray(0, this.#filled);
    if (!this.#upload) {
      if (this.#total < MIN_STORED) return false;
      await this.env.OBJECTS.put(this.key, rest);
    } else {
      if (rest.length > 0) await this.#send(rest);
      await this.#uploading;
      await (await this.#upload).complete(this.#parts);
    }
    await this.#keep();
    return true;
  }

  async abort() {
    if (!this.#upload) return;
    await this.#uploading.catch(() => {});
    await (await this.#upload).abort();
  }

  /** Records this pack as the most recent and deletes those past `KEPT`. */
  async #keep() {
    const listed = await this.env.OBJECTS.get(recentKey(this.repo));
    const recent: string[] = listed ? await listed.json<string[]>() : [];
    const kept = [this.key, ...recent.filter((k) => k !== this.key)];
    await this.env.OBJECTS.put(recentKey(this.repo), JSON.stringify(kept.slice(0, KEPT)));
    const evicted = kept.slice(KEPT).filter((k) => k.startsWith(prefix(this.repo)));
    if (evicted.length) await this.env.OBJECTS.delete(evicted);
  }
}
