// Clones from a stored pack (PACK_CACHE=on). A clone (no haves or shallow commits) gets
// what its wants, filter and depth name, so its pack depends on those alone: a full clone,
// a partial or shallow one, or a partial clone's checkout wanting its files by id. Built
// from bundles, a clone reads all of history raw (168 MiB for claude-code's 32 MiB pack)
// and deltas and compresses it in the Worker: 6-10 s live against GitHub's 1.6-1.9 s. The
// first such clone of a set of tips stores the pack while it streams, behind the response
// (repo-pack-stream `Storing`: the clone never waits on R2); the next streams that one R2
// object. Wants are still walked by the authority first, so a stored pack is served
// only for tips the client may fetch now (a force-push that dropped history leaves its old
// pack unreachable). Key: `derived/v1/<repo>/packs/v2/<sha256 of the sorted wants, then
// the filter and depth lines>.pack`;
// v2 holds the pack as side-band packets (the hit path pipes them as they are), v1 raw.
import { R2Parts } from './repo-r2-parts';
import type { Env } from './types';

/** A stored pack's multipart parts: R2's smallest, so the three a clone holds at most
 * while it stores its pack (`R2Parts.offer`) are 15 MiB. */
export const PART = 5 * 1024 * 1024;

/** Smaller packs build quickly anyway: not stored. */
const MIN_STORED = 256 * 1024;
/** Stored packs kept per repository, most recent first; older ones are deleted. A tip's
 * full, partial and shallow clones and its checkout's files take four. */
const KEPT = 8;

export const packCacheOn = (env: Env) => env.PACK_CACHE === 'on';
const prefix = (repo: string) => `derived/v1/${repo}/packs/v2/`;
const recentKey = (repo: string) => `${prefix(repo)}recent`;

/** Where the pack of a clone wanting `wants` is stored; `shape` names its filter and
 * depth (a full clone's has none, and its key is the sorted wants alone, as before). */
export async function packKey(repo: string, wants: string[], shape = '') {
  const sorted = [...[...new Set(wants)].sort(), ...(shape ? [shape] : [])].join('\n');
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(sorted));
  const name = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `${prefix(repo)}${name}.pack`;
}

/** The stored pack at `key`, or null. */
export const storedPack = (env: Env, key: string) => env.OBJECTS.get(key);

/** Stores a pack as it streams (`R2Parts`), keeping it only when worth it, and the most
 * recent packs of the repository. */
export class PackWriter {
  #parts: R2Parts;

  constructor(
    private readonly env: Env,
    private readonly repo: string,
    private readonly key: string,
    part = PART,
  ) {
    this.#parts = new R2Parts(env, key, {}, part);
  }

  /** Adds `bytes` without waiting, or false when the store fell behind (`R2Parts.offer`). */
  offer(bytes: Uint8Array) {
    return this.#parts.offer(bytes);
  }

  /** Completes the stored pack (unless it is too small to keep) and evicts old ones. */
  async finish() {
    if (this.#parts.size < MIN_STORED) {
      await this.#parts.abort();
      return false;
    }
    await this.#parts.finish();
    await this.#keep();
    return true;
  }

  abort() {
    return this.#parts.abort();
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
