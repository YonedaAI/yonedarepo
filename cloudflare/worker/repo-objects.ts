// Object access for the source platform: tiered reads (edge, R2) in front of each
// repository's object store (repo-stores), a fork's parent's after its own (repo-inherit),
// and verified pushes to it. Objects are immutable, so a cache entry keyed by id never
// needs invalidation; keys are per repository so access follows repository auth. (Over
// 300 lines: every tier of one read stays in this one place.)
import { afterAnswer } from './background';
import { type Location, platformCall, readBundled, readKnown, SMALL_RANGE } from './repo-bundles';
import { cachedCopy, edgePut } from './repo-cache-tiers';
import { compute } from './repo-compute';
import { Inherited } from './repo-inherit';
import { SPILL_BYTES, tooLarge } from './repo-large-files';
import { quarantined, type Withheld, withheldMap } from './repo-quarantine-guard';
import { SharedShardAsk, stagedInShards, stagedWithCommits } from './repo-shard-reads';
import { stagedInShardOf } from './repo-shards';
import {
  type CachedObject,
  fromBase64,
  type ObjectStore,
  parseStore,
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

/** A Git object's id: SHA-1 of `<kind> <size>\0` and its content. */
export async function gitObjectId(kind: string, data: Uint8Array) {
  const header = new TextEncoder().encode(`${kind} ${data.length}\0`);
  const whole = new Uint8Array(header.length + data.length);
  whole.set(header);
  whole.set(data, header.length);
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-1', whole));
  return [...digest].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export type ObjectKind = 'tree' | 'blob' | 'commit';
/** Reads served per tier, for the S12 hit-rate gate: edge (Cache API), R2, object store. */
export type TierHits = { edge: number; r2: number; store: number };
type Tier = keyof TierHits;
/** A walk's answer, and its fills of the tiers above (pending only without a waitUntil). */
type Walked = { bytes: Uint8Array; tier: Tier; filled: Promise<unknown> };
/** Object reads in flight in this isolate, by repository, kind and id. */
const inFlight = new Map<string, Promise<Walked>>();

/**
 * Tiered, content-addressed reads: parsed trees in memory -> Cache API (per colo; it
 * stores nothing on workers.dev) -> R2 (shared) -> object store. Each tier only asks the
 * next one, and a miss fills the tiers above it. Keys carry the repository so cached bytes
 * are only reachable through that repository's auth.
 */
export class RepoObjects {
  readonly hits: TierHits = { edge: 0, r2: 0, store: 0 };
  /** This request's shared asks of every commit shard (`walk`'s last resort). */
  #shards?: SharedShardAsk;
  /** Blobs this repository withholds (quarantine), by id, with the path the owner named:
   * set from the access answer that authorized the request (`withhold`). */
  private withheld: Withheld = new Map();
  /** Whether an access answer set `withheld` (a store adopted from a commit's answer has
   * none; `RepoContext.objects` then reads status before serving from it). */
  knowsWithheld = false;
  /** A fork's parent objects (repo-inherit), asked when this repository's tiers miss. */
  readonly inherited?: Inherited;
  constructor(
    readonly env: Env,
    readonly repo: string,
    readonly store: ObjectStore,
    private readonly trees: TreeMemo = isolateTrees,
  ) {
    const parent = store.inherits;
    if (parent)
      this.inherited = new Inherited(
        new RepoObjects(env, parent.repo, parseStore(env, parent.spec), trees),
      );
  }

  /** Withholds the blobs an access answer lists (`quarantined`: `[{id, path}]`). */
  withhold(list: unknown) {
    if (!Array.isArray(list)) return this;
    this.withheld = withheldMap(list);
    this.knowsWithheld = true;
    return this;
  }

  /** The withheld blobs among `ids`, with their paths: this repository's, and in a fork
   * those its parent withholds (inherited content is the parent's to withhold). */
  async withheldAmong(ids: Iterable<string>): Promise<Withheld> {
    const parent = this.inherited ? await this.inherited.withheld() : new Map();
    const found: Withheld = new Map();
    for (const id of ids) {
      const path = this.withheld.get(id) ?? parent.get(id);
      if (path !== undefined) found.set(id, path);
    }
    return found;
  }

  /** Every blob this repository (or a fork's parent) withholds, with its path. */
  async withheldAll(): Promise<Withheld> {
    const parent = this.inherited ? await this.inherited.withheld() : new Map();
    return new Map([...parent, ...this.withheld]);
  }

  /** Whether this repository (or a fork's parent) withholds any blob. */
  async withholdsAny() {
    return (
      this.withheld.size > 0 ||
      (this.inherited ? (await this.inherited.withheld()).size > 0 : false)
    );
  }

  /** Refuses a withheld blob (QUARANTINED), before any tier is asked for its bytes. */
  async refuse(id: string) {
    const [held] = await this.withheldAmong([id]);
    if (held) throw quarantined(held[0], held[1]);
  }

  /** The store of record: raw Git content of platform-built objects, never deleted. */
  rawKey(id: string) {
    return `platform/v1/${this.repo}/git/${id}`;
  }
  /** The cache tier key (also read by a fork, repo-inherit). */
  key(id: string) {
    return `platform/v1/${this.repo}/objects/${id}`;
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
                edgePut(
                  this.repo,
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
  async read(id: string, kind: ObjectKind, stagedWith?: string): Promise<Uint8Array> {
    if (kind === 'blob') await this.refuse(id);
    // A guarded read never joins an unguarded one (which may serve inherited bytes).
    const key = `${this.repo}/${kind}/${id}${this.inherited?.guard ? '/guarded' : ''}`;
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

  /** Each tier a cold read asks is timed (`read.*`), so a slow read shows where it waited. */
  private async walk(id: string, kind: ObjectKind, stagedWith?: string): Promise<Walked> {
    const copy = await cachedCopy(this.env, this.repo, this.key(id), id, kind);
    if (copy?.tier === 'edge') return { ...copy, filled: Promise.resolve() };
    if (copy) {
      const { bytes } = copy;
      const filled = afterAnswer(() =>
        timed('cache.edge', () => edgePut(this.repo, id, kind, bytes)),
      );
      return { bytes, tier: 'r2', filled };
    }
    const fromRaw = await timed('read.raw', () => this.recorded(id, kind));
    if (fromRaw) return { bytes: this.encode(fromRaw), tier: 'r2', filled: this.fill(fromRaw) };
    // A fork's history is its parent's: ask the parent's cached and recorded copies before
    // this repository's authority and shards.
    const early = await this.inherited?.bytes(id, kind, false);
    if (early) return { bytes: early, tier: 'store', filled: Promise.resolve() };
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
    // A fork's own store holds nothing its parent and R2 do not (and may still be forking).
    if (!object && !this.inherited)
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
    // A fork's parent, every tier: before this repository's shards, since inherited
    // history is read far more often than this repository's not yet drained commits.
    const inherited =
      !object && (await timed('read.parent', async () => this.inherited?.bytes(id, kind, true)));
    if (inherited) return { bytes: inherited, tier: 'store', filled: Promise.resolve() };
    // Commit shards last: finding a staged object there means asking every shard, and
    // imported objects (in Artifacts only) must not pay that on each first read.
    if (!object) {
      this.#shards ??= new SharedShardAsk(this.env, this.repo);
      const shards = this.#shards;
      object = ofKind(await timed('read.shards', () => shards.get(id)));
      object ??= await timed('read.raw', () => this.recorded(id, kind));
    }
    if (!object) throw missing(`${kind[0].toUpperCase()}${kind.slice(1)} ${id}`);
    return { bytes: this.encode(object), tier: 'store', filled: this.fill(object) };
  }

  /** The store of record's copy (raw Git content in R2, or in a push's bundle this
   * isolate has located; the authority locates the rest with the staged read), parsed. */
  async recorded(id: string, kind: ObjectKind): Promise<CachedObject | null> {
    const raw = await this.env.OBJECTS.get(this.rawKey(id));
    // A large file is never parsed or held whole here (repo-large-files).
    if (raw && raw.size > SPILL_BYTES) {
      await raw.body.cancel();
      throw tooLarge(id, raw.size);
    }
    if (raw?.customMetadata?.kind === kind) return this.parsed(id, kind, await raw.arrayBuffer());
    const bundled = (await readKnown(this.env, this.repo, [{ id, kind }])).get(id);
    return bundled ? this.parsed(id, kind, bundled) : null;
  }

  /** Raw Git content as a structured object, checked against its id. A blob is checked here
   * rather than by Rust compute: a compute call holds about 5x its blob in Wasm memory
   * (measured: 85 MiB for a 16 MiB blob, beyond the 21 MiB input), and Wasm memory never
   * shrinks, so one large blob left the isolate over its memory limit (503 on /objects). */
  private async parsed(
    id: string,
    kind: ObjectKind,
    bytes: ArrayBuffer | Uint8Array,
  ): Promise<CachedObject> {
    const data = new Uint8Array(bytes);
    if (kind === 'blob') {
      if ((await gitObjectId('blob', data)) !== id)
        throw Object.assign(new Error(`Blob ${id} does not match its id`), {
          code: 'OBJECT_INVALID',
        });
      return { id, kind, data_b64: toBase64(data) };
    }
    return compute({ op: 'parse_objects', objects: [{ id, kind, data_b64: toBase64(data) }] })
      .objects[0] as CachedObject;
  }

  encode(object: CachedObject) {
    return object.kind === 'blob'
      ? fromBase64(object.data_b64)
      : new TextEncoder().encode(JSON.stringify(object));
  }

  /**
   * Raw content of objects for a pack, once per id: the store of record (R2: bundles where
   * the repository holds any, then one object per key), a fork's parent's store of record,
   * then the authority's staged copy or bundle location for objects still missing, the
   * commit shards (once for all; `owners` names the commit an object was staged with, so
   * only its shard is asked), and a fork's parent's every tier last. Missing ones are left
   * out. Bundled bytes come in ranges of `SMALL_RANGE`: callers hold every result at once.
   * With `large`, files too large to hold are listed there (id → size), not read.
   */
  async raw(
    asked: { id: string; kind: string }[],
    owners?: Map<string, string>,
    large?: Map<string, number>,
  ): Promise<RawObject[]> {
    const wanted = [...new Map(asked.map((w) => [w.id, w])).values()];
    const found = new Map((await this.stored(wanted, large)).map((o) => [o.id, o]));
    const add = (w: { id: string; kind: string }, data: Uint8Array) =>
      found.set(w.id, { id: w.id, kind: w.kind as RawObject['kind'], data_b64: toBase64(data) });
    const missing = (list: typeof wanted) =>
      list.filter((w) => !found.has(w.id) && !large?.has(w.id));
    for (const o of (await this.inherited?.raw(missing(wanted), false)) ?? []) found.set(o.id, o);
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
    }
    // Commit shards once for all still missing: their commits' shards when the caller
    // names them (`owners`: id → commit), else every shard.
    const ids = missing(absent).map((w) => w.id);
    const sharded = owners
      ? await stagedWithCommits(this.env, this.repo, ids, owners, true)
      : await stagedInShards(this.env, this.repo, ids, true);
    for (const o of sharded as RawObject[]) found.set(o.id, o);
    // A staged copy is dropped only after its R2 write: look in R2 once more.
    for (const o of await this.stored(missing(absent), large)) found.set(o.id, o);
    for (const o of (await this.inherited?.raw(missing(wanted), true)) ?? []) found.set(o.id, o);
    return [...found.values()];
  }

  /** Raw content of `wanted` the store of record holds: bundles, then one R2 object each. */
  async stored(
    wanted: { id: string; kind: string }[],
    large?: Map<string, number>,
  ): Promise<RawObject[]> {
    const found = new Map<string, RawObject>();
    const add = (w: { id: string; kind: string }, data: Uint8Array) =>
      found.set(w.id, { id: w.id, kind: w.kind as RawObject['kind'], data_b64: toBase64(data) });
    if (wanted.length === 0) return [];
    const bundled = await readBundled(this.env, this.repo, wanted, SMALL_RANGE);
    for (const w of wanted) if (bundled.has(w.id)) add(w, bundled.get(w.id) as Uint8Array);
    const rest = wanted.filter((w) => !found.has(w.id));
    for (let i = 0; i < rest.length; i += CACHE_CHUNK)
      await Promise.all(
        rest.slice(i, i + CACHE_CHUNK).map(async (w) => {
          const stored = await this.env.OBJECTS.get(this.rawKey(w.id));
          if (stored && stored.size > SPILL_BYTES) {
            await stored.body.cancel();
            if (!large) throw tooLarge(w.id, stored.size);
            large.set(w.id, stored.size);
            return;
          }
          if (stored) add(w, new Uint8Array(await stored.arrayBuffer()));
        }),
      );
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
    // A guarded read skips this isolate's memory, which may hold inherited trees.
    const remembered = this.inherited?.guard ? undefined : this.remembered(id);
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
