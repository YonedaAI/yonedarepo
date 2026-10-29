// Clones from a stored pack (PACK_CACHE=on). A fetch that has nothing (no haves or shallow
// commits) gets what its wants, filter and depth name, so its pack depends on those alone:
// a full clone, a partial or shallow one, or a partial clone's checkout wanting its files
// by id. Built from bundles, a clone reads all of history raw (168 MiB for claude-code's
// 32 MiB pack) and deltas and compresses it in the Worker: 6-10 s live against GitHub's
// 1.6-1.9 s, 135 s for svelte. So the pack is stored once and later clones stream that one
// R2 object: by the first such clone while it streams, behind the response (repo-pack-stream
// `Storing`: the clone never waits on R2), or, when that clone cannot store it (its isolate's
// Wasm is too high, or the store fell behind), by a pack-build job it hands the fetch to;
// and after a push to main, a job builds that tip's packs before anyone asks
// (repo-pack-jobs). Wants are still walked by the authority first, so a stored pack is
// served only for tips the client may fetch now (a force-push that dropped history leaves
// its old pack unreachable). Key: `derived/v1/<repo>/packs/v2/<sha256 of the sorted wants,
// then the filter and depth lines>.pack`; v2 holds the pack as side-band packets (the hit
// path pipes them as they are), v1 raw.
import { R2Parts } from './repo-r2-parts';
import type { Env } from './types';

/** A stored pack's multipart parts: R2's smallest, so the three a clone holds at most
 * while it stores its pack (`R2Parts.offer`) are 15 MiB. */
export const PART = 5 * 1024 * 1024;

/** Smaller packs build quickly anyway: a clone does not store them. */
const MIN_STORED = 256 * 1024;
/** Stored packs kept per repository, most recent first; older ones are deleted. A tip's
 * full, partial and shallow clones and a partial clone's checkout take four. */
export const KEPT = 4;

/** A fetch that has nothing: what it wants, with its filter and depth. */
export type Fresh = {
  wants: string[];
  omit_blobs: boolean;
  depth: number | null;
  deepen_relative: boolean;
};

export const packCacheOn = (env: Env) => env.PACK_CACHE === 'on';
export const packsPrefix = (repo: string) => `derived/v1/${repo}/packs/v2/`;
const recentKey = (repo: string) => `${packsPrefix(repo)}recent`;

/** The filter and depth lines of `fresh` (none for a full clone). */
function shape(fresh: Fresh) {
  return [
    fresh.omit_blobs ? 'filter blob:none' : '',
    fresh.depth != null ? `deepen ${fresh.depth}` : '',
    fresh.deepen_relative ? 'deepen-relative' : '',
  ].filter(Boolean);
}

/** Where the pack of `fresh` is stored (a full clone's key is its sorted wants alone). */
export async function packKey(repo: string, fresh: Fresh) {
  const lines = [...[...new Set(fresh.wants)].sort(), ...shape(fresh)].join('\n');
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(lines));
  const name = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `${packsPrefix(repo)}${name}.pack`;
}

/** The stored pack at `key`, or null. */
export const storedPack = (env: Env, key: string) => env.OBJECTS.get(key);

/** A stored pack's entry in the repository's recent list: built by a job for main's
 * `tip` (deleted once a later tip's are built), or stored by a clone (no tip). */
type Kept = { key: string; tip?: string };

/** Stores a pack as it streams (`R2Parts`), keeping it only when worth it, and the most
 * recent packs of the repository. */
export class PackWriter {
  #parts: R2Parts;

  /** `tip`: main's commit a job built this pack for. */
  constructor(
    private readonly env: Env,
    private readonly repo: string,
    private readonly key: string,
    part = PART,
    private readonly tip?: string,
  ) {
    this.#parts = new R2Parts(env, key, {}, part);
  }

  /** Adds `bytes` without waiting, or false when the store fell behind (`R2Parts.offer`). */
  offer(bytes: Uint8Array) {
    return this.#parts.offer(bytes);
  }

  /** Adds `bytes`, waiting while two parts are on their way up (a job, not a clone). */
  add(bytes: Uint8Array) {
    return this.#parts.add(bytes);
  }

  /** Completes the stored pack (unless under `minimum` bytes) and evicts old ones. */
  async finish(minimum = MIN_STORED) {
    if (this.#parts.size < minimum) {
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

  /** Records this pack as the most recent and deletes those past `KEPT`, and with a
   * `tip`, those built for another tip (superseded). */
  async #keep() {
    const listed = await this.env.OBJECTS.get(recentKey(this.repo));
    const recent = listed ? (await listed.json<(Kept | string)[]>()).map(entry) : [];
    const all = [{ key: this.key, tip: this.tip }, ...recent.filter((k) => k.key !== this.key)];
    const superseded = (k: Kept) => this.tip !== undefined && k.tip && k.tip !== this.tip;
    const kept = all.filter((k) => !superseded(k)).slice(0, KEPT);
    await this.env.OBJECTS.put(recentKey(this.repo), JSON.stringify(kept));
    const evicted = all
      .filter((k) => !kept.includes(k) && k.key.startsWith(packsPrefix(this.repo)))
      .map((k) => k.key);
    if (evicted.length) await this.env.OBJECTS.delete(evicted);
  }
}

/** A recent list entry (the list held bare keys before tips were recorded). */
const entry = (k: Kept | string): Kept => (typeof k === 'string' ? { key: k } : k);
