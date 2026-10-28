// Object access for the source platform: tiered reads (edge, R2) in front of each
// repository's object store (repo-stores), and verified pushes to it. Objects are
// immutable, so a cache entry keyed by id never needs invalidation; keys are per
// repository so access follows repository auth.
import { deferred } from './background';
import { fromBundles, platformCall } from './repo-bundles';
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
/** Object reads in flight in this isolate, by repository, kind and id. */
const inFlight = new Map<string, Promise<{ bytes: Uint8Array; tier: Tier }>>();
const EDGE_ORIGIN = 'https://objects.yoneda.internal';

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
   * reads of one object in this isolate share one walk down the tiers. */
  private async read(id: string, kind: ObjectKind, stagedWith?: string): Promise<Uint8Array> {
    const key = `${this.repo}/${kind}/${id}`;
    let reading = inFlight.get(key);
    if (!reading) {
      reading = this.walk(id, kind, stagedWith).finally(() => inFlight.delete(key));
      inFlight.set(key, reading);
    }
    const { bytes, tier } = await reading;
    this.hits[tier]++;
    return bytes;
  }

  /** Fills the tiers above the one that served `object`: the edge at once, R2 after the
   * response when the request lends its waitUntil (an R2 write costs a reader ~200 ms). */
  private async fill(object: CachedObject) {
    const r2 = () => timed('cache.r2', () => putObjects(this.env, (id) => this.key(id), [object]));
    if (!deferred(r2)) await r2();
    await this.cache([object], 'edge');
  }

  private async walk(
    id: string,
    kind: ObjectKind,
    stagedWith?: string,
  ): Promise<{ bytes: Uint8Array; tier: Tier }> {
    const edge = await caches.default.match(this.edgeKey(id)).catch(() => undefined);
    if (edge && edge.headers.get('x-kind') === kind)
      return { bytes: new Uint8Array(await edge.arrayBuffer()), tier: 'edge' };
    const cached = await this.env.OBJECTS.get(this.key(id));
    if (cached && (cached.customMetadata?.kind ?? kind) === kind) {
      const bytes = new Uint8Array(await cached.arrayBuffer());
      await this.edgePut(id, kind, bytes);
      return { bytes, tier: 'r2' };
    }
    const fromRaw = await this.recorded(id, kind);
    if (fromRaw) {
      await this.fill(fromRaw);
      return { bytes: this.encode(fromRaw), tier: 'r2' };
    }
    // Staged with a commit the caller names (one shard), before the tiers that ask the
    // authority, the object store or every shard.
    if (stagedWith) {
      const [held] = (await stagedInShardOf(this.env, this.repo, stagedWith, [
        id,
      ])) as CachedObject[];
      if (held?.kind === kind) {
        await this.fill(held);
        return { bytes: this.encode(held), tier: 'store' };
      }
    }
    // Accepted but not yet in R2: the authority still holds the staged copy. A staged copy
    // is dropped only after its R2 write, so a miss there means R2 has it now.
    const ofKind = (o: CachedObject | null | undefined) => (o?.kind === kind ? o : null);
    let object: CachedObject | null = ofKind(await this.staged(id));
    object ??= await this.recorded(id, kind);
    if (!object) {
      if (kind === 'tree') {
        const entries = await this.store.readTree(id);
        object = entries && { id, kind, entries };
      } else if (kind === 'blob') {
        const bytes = await this.store.readBlob(id);
        object = bytes && { id, kind, data_b64: toBase64(bytes) };
      } else {
        const commit = await this.store.readCommit(id);
        object = commit && { id, kind, ...commit };
      }
    }
    // Commit shards last: finding a staged object there means asking every shard, and
    // imported objects (in Artifacts only) must not pay that on each first read.
    if (!object) {
      object = ofKind((await stagedInShards(this.env, this.repo, [id]))[0] as CachedObject);
      object ??= await this.recorded(id, kind);
    }
    if (!object) throw missing(`${kind[0].toUpperCase()}${kind.slice(1)} ${id}`);
    await this.fill(object);
    return { bytes: this.encode(object), tier: 'store' };
  }

  /** The store of record's copy (raw Git content in R2, alone or in a push's bundle),
   * parsed. */
  private async recorded(id: string, kind: ObjectKind): Promise<CachedObject | null> {
    const raw = await this.env.OBJECTS.get(this.rawKey(id));
    let bytes: Uint8Array | null =
      raw?.customMetadata?.kind === kind ? new Uint8Array(await raw.arrayBuffer()) : null;
    bytes ??= (await fromBundles(this.env, this.repo, [{ id, kind }])).get(id) ?? null;
    if (!bytes) return null;
    const data_b64 = toBase64(bytes);
    return compute({ op: 'parse_objects', objects: [{ id, kind, data_b64 }] })
      .objects[0] as CachedObject;
  }

  private encode(object: CachedObject) {
    return object.kind === 'blob'
      ? fromBase64(object.data_b64)
      : new TextEncoder().encode(JSON.stringify(object));
  }

  /**
   * Raw content of objects for a pack: the store of record (R2: bundles, then one object
   * per key), then the authority's staged copy for objects still in flight. Missing ones
   * are left out.
   */
  async raw(wanted: { id: string; kind: string }[]): Promise<RawObject[]> {
    const bundled = await fromBundles(this.env, this.repo, wanted);
    const found: RawObject[] = [];
    const rest: { id: string; kind: string }[] = [];
    for (const w of wanted) {
      const data = bundled.get(w.id);
      if (data)
        found.push({ id: w.id, kind: w.kind as RawObject['kind'], data_b64: toBase64(data) });
      else rest.push(w);
    }
    const absent: { id: string; kind: string }[] = [];
    for (let i = 0; i < rest.length; i += CACHE_CHUNK) {
      await Promise.all(
        rest.slice(i, i + CACHE_CHUNK).map(async (w) => {
          const stored = await this.env.OBJECTS.get(this.rawKey(w.id));
          if (stored)
            found.push({
              id: w.id,
              kind: w.kind as RawObject['kind'],
              data_b64: toBase64(new Uint8Array(await stored.arrayBuffer())),
            });
          else absent.push(w);
        }),
      );
    }
    for (let i = 0; i < absent.length; i += 64) {
      const ids = absent.slice(i, i + 64).map((w) => w.id);
      const here = (await this.stagedCall({ ids, raw: true })) as RawObject[];
      const sharded = (await stagedInShards(
        this.env,
        this.repo,
        ids.filter((id) => !here.some((o) => o.id === id)),
        true,
      )) as RawObject[];
      found.push(...here, ...sharded);
      // A staged copy is dropped only after its R2 write: look in R2 once more.
      const held = new Set([...here, ...sharded].map((o) => o.id));
      for (const id of ids.filter((i) => !held.has(i))) {
        const stored = await this.env.OBJECTS.get(this.rawKey(id));
        if (stored)
          found.push({
            id,
            kind: stored.customMetadata?.kind as RawObject['kind'],
            data_b64: toBase64(new Uint8Array(await stored.arrayBuffer())),
          });
      }
    }
    return found;
  }

  /** The authority's staged copy of an accepted object (read as the platform: callers
   * reach this tier only through the same authorization as the object store). */
  private async staged(id: string): Promise<CachedObject | null> {
    return ((await this.stagedCall({ ids: [id] })) as CachedObject[])[0] ?? null;
  }

  private async stagedCall(args: { ids: string[]; raw?: true }): Promise<unknown[]> {
    const value = await platformCall(this.env, this.repo, { op: 'repo_staged_objects', ...args });
    return value.objects ?? [];
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
