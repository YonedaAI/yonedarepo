// Object access for the source platform: tiered reads (edge, R2) in front of each
// repository's object store (repo-stores), and verified pushes to it. Objects are
// immutable, so a cache entry keyed by id never needs invalidation; keys are per
// repository so access follows repository auth.
import { afterAnswer } from './background';
import { type Location, platformCall, readBundled, readKnown, SMALL_RANGE } from './repo-bundles';
import { compute } from './repo-compute';
import { stagedInShardOf, stagedInShards } from './repo-shards';
import {
  type CachedObject,
  fromBase64,
  type ObjectStore,
  putObjects,
  type RawObject,
  type TreeEntry,
  toBase64,
} from './repo-stores';
import { timed } from './repo-timing';
import { isolateTrees, type TreeMemo } from './repo-tree-memo';
import type { Env } from './types';

// Stores and object forms, for callers that know this module as the object layer.
export {
  type CachedObject,
  fromBase64,
  newStore,
  type ObjectStore,
  parseStore,
  type TreeEntry,
  toBase64,
} from './repo-stores';

const CACHE_CHUNK = 256;
/** Commits up to this many objects write the cache alongside their push. */
export const OVERLAP_CACHE_OBJECTS = 64;
const missing = (what: string) =>
  Object.assign(new Error(`${what} is missing`), { code: 'NOT_FOUND' });

export type ObjectKind = 'tree' | 'blob' | 'commit';
/** Reads served per tier, for the S12 hit-rate gate: edge (Cache API), R2, object store. */
export type TierHits = { edge: number; r2: number; store: number };
type Tier = keyof TierHits;
/** A walk's answer, and its fills of the tiers above (pending only without a waitUntil). */
type Walked = { bytes: Uint8Array; tier: Tier; filled: Promise<unknown> };
/** Object reads in flight in this isolate, by repository, kind and id. */
const inFlight = new Map<string, Promise<Walked>>();
const EDGE_ORIGIN = 'https://objects.yoneda.internal';
/** How long a read waits for the edge before asking R2. An edge hit answers in
 * milliseconds; hosted burst read-backs (2026-10-28) saw Cache API calls of 24-33 s. */
const EDGE_WAIT_MS = 500;

/**
 * Tiered, content-addressed reads: parsed trees in memory -> Cache API (per colo; it
 * stores nothing on workers.dev) -> R2 (shared) -> object store. Each tier only asks the
 * next one, and a miss fills the tiers above it. Keys carry the repository so cached bytes
 * are only reachable through that repository's auth.
 */
export class RepoObjects {
  readonly hits: TierHits = { edge: 0, r2: 0, store: 0 };
  constructor(
    readonly env: Env,
    readonly repo: string,
    readonly store: ObjectStore,
    private readonly trees: TreeMemo = isolateTrees,
  ) {}

  /** The store of record: raw Git content of platform-built objects, never deleted. */
  rawKey(id: string) {
    return `platform/v1/${this.repo}/git/${id}`;
  }
  private key(id: string) {
    return `platform/v1/${this.repo}/objects/${id}`;
  }
  private edgeKey(id: string) {
    return new Request(`${EDGE_ORIGIN}/${this.repo}/${id}`);
  }
  private async edgePut(id: string, kind: ObjectKind, body: Uint8Array | string) {
    try {
      await caches.default.put(
        this.edgeKey(id),
        new Response(body, {
          headers: { 'cache-control': 'public, max-age=31536000, immutable', 'x-kind': kind },
        }),
      );
    } catch {
      // The edge tier is an optimization; R2 remains authoritative for cached objects.
    }
  }

  /** Writes both tiers (or one) in bounded chunks: unbounded fan-out stalls on large
   * imports. */
  async cache(objects: CachedObject[], tiers: 'all' | 'edge' | 'r2' = 'all') {
    // Trees written here are the ones this isolate's next commits build on.
    for (const o of objects) if (o.kind === 'tree') this.trees.set(this.repo, o.id, o.entries);
    for (let i = 0; i < objects.length; i += CACHE_CHUNK) {
      const chunk = objects.slice(i, i + CACHE_CHUNK);
      await Promise.all([
        tiers !== 'edge' &&
          timed('cache.r2', () => putObjects(this.env, (id) => this.key(id), chunk)),
        tiers !== 'r2' &&
          timed('cache.edge', () =>
            Promise.all(
              chunk.map((o) =>
                this.edgePut(
                  o.id,
                  o.kind,
                  o.kind === 'blob' ? fromBase64(o.data_b64) : JSON.stringify(o),
                ),
              ),
            ),
          ),
      ]);
    }
  }

  /** Raw tier bytes for `id` (JSON for trees/commits, content for blobs). Concurrent
   * reads of one object in this isolate share one walk down the tiers; only the read that
   * started it waits for its fills (`read.joined`: the time a read waited on another's). */
  private async read(id: string, kind: ObjectKind, stagedWith?: string): Promise<Uint8Array> {
    const key = `${this.repo}/${kind}/${id}`;
    const shared = inFlight.get(key);
    let reading = shared;
    if (!reading) {
      reading = this.walk(id, kind, stagedWith).finally(() => inFlight.delete(key));
      inFlight.set(key, reading);
    }
    const { bytes, tier, filled } = shared
      ? await timed('read.joined', () => shared)
      : await reading;
    if (!shared) await filled;
    this.hits[tier]++;
    return bytes;
  }

  /** Fills the tiers above the one that served `object`, after the answer when the request
   * lends its waitUntil (an R2 write costs a reader ~200 ms; a Cache API put took up to
   * 33 s in hosted burst read-backs), else in the promise answered. */
  private fill(object: CachedObject) {
    return afterAnswer(() => this.cache([object]));
  }

  /** The edge copy of `id`, or null on a miss, a failure or a lookup slower than
   * EDGE_WAIT_MS (the edge tier is an optimization: R2 answers instead). */
  private async edgeHit(id: string, kind: ObjectKind): Promise<Uint8Array | null> {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const late = new Promise<null>((done) => {
      timer = setTimeout(() => done(null), EDGE_WAIT_MS);
    });
    const lookup = caches.default
      .match(this.edgeKey(id))
      .then(async (hit) =>
        hit && hit.headers.get('x-kind') === kind ? new Uint8Array(await hit.arrayBuffer()) : null,
      )
      .catch(() => null);
    try {
      return await Promise.race([lookup, late]);
    } finally {
      clearTimeout(timer);
    }
  }

  /** Each tier a cold read asks is timed (`read.*`), so a slow read shows where it waited. */
  private async walk(id: string, kind: ObjectKind, stagedWith?: string): Promise<Walked> {
    const edge = await timed('read.edge', () => this.edgeHit(id, kind));
    if (edge) return { bytes: edge, tier: 'edge', filled: Promise.resolve() };
    const cached = await timed('read.r2', () => this.env.OBJECTS.get(this.key(id)));
    if (cached && (cached.customMetadata?.kind ?? kind) === kind) {
      const bytes = new Uint8Array(await cached.arrayBuffer());
      const filled = afterAnswer(() => timed('cache.edge', () => this.edgePut(id, kind, bytes)));
      return { bytes, tier: 'r2', filled };
    }
    const fromRaw = await timed('read.raw', () => this.recorded(id, kind));
    if (fromRaw) return { bytes: this.encode(fromRaw), tier: 'r2', filled: this.fill(fromRaw) };
    // Staged with a commit the caller names (one shard), before the tiers that ask the
    // authority, the object store or every shard.
    if (stagedWith) {
      const [held] = (await timed('read.shard', () =>
        stagedInShardOf(this.env, this.repo, stagedWith, [id]),
      )) as CachedObject[];
      if (held?.kind === kind)
        return { bytes: this.encode(held), tier: 'store', filled: this.fill(held) };
    }
    // Accepted but not yet in R2: the authority still holds the staged copy. A staged copy
    // is dropped only after its R2 write, so a miss there means R2 has it now.
    const ofKind = (o: CachedObject | null | undefined) => (o?.kind === kind ? o : null);
    let object: CachedObject | null = ofKind(
      await timed('read.staged', () => this.staged(id, kind)),
    );
    object ??= await timed('read.raw', () => this.recorded(id, kind));
    if (!object)
      object = await timed('read.store', async () => {
        if (kind === 'tree') {
          const entries = await this.store.readTree(id);
          return entries && { id, kind, entries };
        }
        if (kind === 'blob') {
          const bytes = await this.store.readBlob(id);
          return bytes && { id, kind, data_b64: toBase64(bytes) };
        }
        const commit = await this.store.readCommit(id);
        return commit && { id, kind, ...commit };
      });
    // Commit shards last: finding a staged object there means asking every shard, and
    // imported objects (in Artifacts only) must not pay that on each first read.
    if (!object) {
      object = ofKind(
        (
          await timed('read.shards', () => stagedInShards(this.env, this.repo, [id]))
        )[0] as CachedObject,
      );
      object ??= await timed('read.raw', () => this.recorded(id, kind));
    }
    if (!object) throw missing(`${kind[0].toUpperCase()}${kind.slice(1)} ${id}`);
    return { bytes: this.encode(object), tier: 'store', filled: this.fill(object) };
  }

  /** The store of record's copy (raw Git content in R2, or in a push's bundle this
   * isolate has located; the authority locates the rest with the staged read), parsed. */
  private async recorded(id: string, kind: ObjectKind): Promise<CachedObject | null> {
    const raw = await this.env.OBJECTS.get(this.rawKey(id));
    if (raw?.customMetadata?.kind === kind) return this.parsed(id, kind, await raw.arrayBuffer());
    const bundled = (await readKnown(this.env, this.repo, [{ id, kind }])).get(id);
    return bundled ? this.parsed(id, kind, bundled) : null;
  }

  private parsed(id: string, kind: ObjectKind, bytes: ArrayBuffer | Uint8Array) {
    const data_b64 = toBase64(new Uint8Array(bytes));
    return compute({ op: 'parse_objects', objects: [{ id, kind, data_b64 }] })
      .objects[0] as CachedObject;
  }

  private encode(object: CachedObject) {
    return object.kind === 'blob'
      ? fromBase64(object.data_b64)
      : new TextEncoder().encode(JSON.stringify(object));
  }

  /**
   * Raw content of objects for a pack, once per id: the store of record (R2: bundles where
   * the repository holds any, then one object per key), then the authority's staged copy
   * or bundle location for objects still missing. Missing ones are left out. Bundled bytes
   * come in ranges of `SMALL_RANGE`: callers hold every result at once.
   */
  async raw(asked: { id: string; kind: string }[]): Promise<RawObject[]> {
    const wanted = [...new Map(asked.map((w) => [w.id, w])).values()];
    const found = new Map<string, RawObject>();
    const add = (w: { id: string; kind: string }, data: Uint8Array) =>
      found.set(w.id, { id: w.id, kind: w.kind as RawObject['kind'], data_b64: toBase64(data) });
    const missing = (list: typeof wanted) => list.filter((w) => !found.has(w.id));
    const fromR2 = async (list: typeof wanted) => {
      for (let i = 0; i < list.length; i += CACHE_CHUNK)
        await Promise.all(
          list.slice(i, i + CACHE_CHUNK).map(async (w) => {
            const stored = await this.env.OBJECTS.get(this.rawKey(w.id));
            if (stored) add(w, new Uint8Array(await stored.arrayBuffer()));
          }),
        );
    };
    const bundled = await readBundled(this.env, this.repo, wanted, SMALL_RANGE);
    for (const w of wanted) if (bundled.has(w.id)) add(w, bundled.get(w.id) as Uint8Array);
    await fromR2(missing(wanted));
    const absent = missing(wanted);
    for (let i = 0; i < absent.length; i += 64) {
      const chunk = absent.slice(i, i + 64);
      const answer = await this.stagedCall({
        ids: chunk.map((w) => w.id),
        raw: true,
        locate: true,
      });
      for (const o of answer.objects as RawObject[]) found.set(o.id, o);
      const located = await readKnown(this.env, this.repo, chunk, answer.located, SMALL_RANGE);
      for (const w of chunk) if (located.has(w.id)) add(w, located.get(w.id) as Uint8Array);
      const ids = missing(chunk).map((w) => w.id);
      for (const o of (await stagedInShards(this.env, this.repo, ids, true)) as RawObject[])
        found.set(o.id, o);
      // A staged copy is dropped only after its R2 write: look in R2 once more.
      await fromR2(missing(chunk));
    }
    return [...found.values()];
  }

  /** The authority's staged copy of an accepted object, or its place in a bundle (read as
   * the platform: callers reach this tier only through the same authorization as the
   * object store). */
  private async staged(id: string, kind: ObjectKind): Promise<CachedObject | null> {
    const answer = await this.stagedCall({ ids: [id], locate: true });
    const held = (answer.objects as CachedObject[])[0];
    if (held) return held;
    const bundled = (await readKnown(this.env, this.repo, [{ id, kind }], answer.located)).get(id);
    return bundled ? this.parsed(id, kind, bundled) : null;
  }

  private async stagedCall(args: { ids: string[]; raw?: true; locate?: true }) {
    const value = await platformCall(this.env, this.repo, { op: 'repo_staged_objects', ...args });
    return { objects: (value.objects ?? []) as unknown[], located: value.located as Location[] };
  }

  /** Tree `id`'s entries; `stagedWith` names a commit that may hold it staged in its shard
   * (the commit that built it, before its objects drain to R2). */
  async tree(id: string, stagedWith?: string): Promise<TreeEntry[]> {
    const remembered = this.remembered(id);
    if (remembered) return remembered;
    const bytes = await this.read(id, 'tree', stagedWith);
    const { entries } = JSON.parse(new TextDecoder().decode(bytes)) as { entries: TreeEntry[] };
    this.trees.set(this.repo, id, entries);
    return entries;
  }

  /** Tree `id`'s entries if this memory holds them (no I/O). */
  remembered(id: string): TreeEntry[] | undefined {
    return this.trees.get(this.repo, id);
  }

  /** Remembers trees another holder served (content-addressed, so safe to keep). */
  remember(trees: Record<string, TreeEntry[]>) {
    for (const [id, entries] of Object.entries(trees)) this.trees.set(this.repo, id, entries);
  }

  blob(id: string): Promise<Uint8Array> {
    return this.read(id, 'blob');
  }

  /** One object in the structured form clients receive from `objects`. */
  async object(id: string, kind: ObjectKind): Promise<CachedObject> {
    const bytes = await this.read(id, kind);
    if (kind === 'blob') return { id, kind, data_b64: toBase64(bytes) };
    const parsed = JSON.parse(new TextDecoder().decode(bytes));
    return kind === 'tree'
      ? { id, kind, entries: parsed.entries }
      : { id, kind, tree: parsed.tree, parents: parsed.parents };
  }

  push(body: Uint8Array) {
    return this.store.push(body);
  }
}
