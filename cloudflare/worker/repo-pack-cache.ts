// Full clones from a stored pack (PACK_CACHE=on). A full clone (no haves, filter or depth)
// gets every object reachable from its wants, so its pack depends on the wants alone. Built
// from bundles, a clone reads all of history raw (168 MiB for claude-code's 32 MiB pack)
// and deltas and compresses it in the Worker: 6-10 s live against GitHub's 1.6-1.9 s. The
// first such clone of a set of tips stores the pack while it streams; the next streams that
// one R2 object. Wants are still walked by the authority first, so a stored pack is served
// only for tips the client may fetch now (a force-push that dropped history leaves its old
// pack unreachable). Key: `derived/v1/<repo>/packs/v1/<sha256 of the sorted wants>.pack`.
import { PART, R2Parts } from './repo-r2-parts';
import type { Env } from './types';

export { PART };

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

  add(bytes: Uint8Array) {
    return this.#parts.add(bytes);
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
