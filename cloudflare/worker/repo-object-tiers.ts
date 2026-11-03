// Tier traversal for one repository's immutable objects. Worker loads share only their
// request; an explicit Durable Object owner may retain and share its own pending reads.
import { afterAnswer } from './background';
import { type DurableFlightOwner, Flights } from './flights';
import { cachedCopy, edgePut } from './repo-cache-tiers';
import { automaticLocality, keepNearby, localityRegion, readNearby } from './repo-locality';
import type { ObjectKind, ObjectRecords } from './repo-object-records';
import type { RepoObjects } from './repo-objects';
import { SharedShardAsk } from './repo-shard-reads';
import { stagedInShardOf } from './repo-shards';
import { type CachedObject, toBase64 } from './repo-stores';
import { timed } from './repo-timing';

/** Reads served per tier, for the S12 hit-rate gate: edge (Cache API), R2, object store. */
export type TierHits = { edge: number; r2: number; store: number };
type Tier = keyof TierHits;
/** A walk's answer, and its fills of the tiers above (pending only without a waitUntil). */
type Walked = { bytes: Uint8Array; tier: Tier; filled: Promise<unknown>; nearby?: boolean };
/** Request-local unfinished object reads, by repository, kind and id. */
const inFlight = new Flights<Walked>();
const missing = (what: string) =>
  Object.assign(new Error(`${what} is missing`), { code: 'NOT_FOUND' });

type ReadContext = Pick<RepoObjects, 'env' | 'repo' | 'store' | 'inherited' | 'cache'>;

export class ObjectReader {
  readonly hits: TierHits = { edge: 0, r2: 0, store: 0 };
  #shards?: SharedShardAsk;
  readonly #pending: Flights<Walked>;

  constructor(
    private readonly objects: ReadContext,
    private readonly records: ObjectRecords,
    owner?: DurableFlightOwner,
  ) {
    this.#pending = owner ? new Flights<Walked>(owner) : inFlight;
  }

  /** Raw tier bytes for `id` (JSON for trees/commits, content for blobs). Concurrent
   * reads of one object in this request share one walk down the tiers; only the read that
   * started it waits for its fills (`read.joined`: the time a read waited on another's). */
  async read(id: string, kind: ObjectKind, stagedWith?: string): Promise<Uint8Array> {
    // A guarded read never joins an unguarded one (which may serve inherited bytes).
    const region = localityRegion(this.objects.env);
    const key = `${this.objects.repo}/${kind}/${id}${this.objects.inherited?.guard ? '/guarded' : ''}${region ? `/copy:${region}` : ''}`;
    const { work, joined } = this.#pending.join(key, () => this.walk(id, kind, stagedWith));
    const { bytes, tier, filled, nearby } = joined
      ? await timed('read.joined', () => work)
      : await work;
    if (!joined) {
      await filled;
      if (
        !nearby &&
        automaticLocality(this.objects.env) &&
        !this.objects.inherited &&
        kind !== 'commit' &&
        bytes.byteLength <= 1024 * 1024
      ) {
        const object: CachedObject =
          kind === 'blob'
            ? { id, kind, data_b64: toBase64(bytes) }
            : JSON.parse(new TextDecoder().decode(bytes));
        await keepNearby(this.objects.env, this.objects.repo, object);
      }
    }
    this.hits[tier]++;
    return bytes;
  }

  /** Fills the tiers above the one that served `object`, after the answer when the request
   * lends its waitUntil (an R2 write costs a reader ~200 ms; a Cache API put took up to
   * 33 s in hosted burst read-backs), else in the promise answered. */
  private fill(object: CachedObject) {
    return afterAnswer(() => this.objects.cache([object]));
  }

  /** Each tier a cold read asks is timed (`read.*`), so a slow read shows where it waited. */
  private async walk(id: string, kind: ObjectKind, stagedWith?: string): Promise<Walked> {
    const nearby =
      automaticLocality(this.objects.env) &&
      !this.objects.inherited &&
      (await timed('read.nearby', () => readNearby(this.objects.env, this.objects.repo, id, kind)));
    if (nearby)
      return {
        bytes: this.records.encode(nearby),
        tier: 'store',
        filled: Promise.resolve(),
        nearby: true,
      };
    const copy = await cachedCopy(
      this.objects.env,
      this.objects.repo,
      this.records.key(id),
      id,
      kind,
    );
    if (copy?.tier === 'edge') return { ...copy, filled: Promise.resolve() };
    if (copy) {
      const { bytes } = copy;
      const filled = afterAnswer(() =>
        timed('cache.edge', () => edgePut(this.objects.repo, id, kind, bytes)),
      );
      return { bytes, tier: 'r2', filled };
    }
    const fromRaw = await timed('read.raw', () => this.records.recorded(id, kind));
    if (fromRaw)
      return { bytes: this.records.encode(fromRaw), tier: 'r2', filled: this.fill(fromRaw) };
    // A fork's history is its parent's: ask the parent's cached and recorded copies before
    // this repository's authority and shards.
    const early = await this.objects.inherited?.bytes(id, kind, false);
    if (early) return { bytes: early, tier: 'store', filled: Promise.resolve() };
    // Staged with a commit the caller names (one shard), before the tiers that ask the
    // authority, the object store or every shard.
    if (stagedWith) {
      const [held] = (await timed('read.shard', () =>
        stagedInShardOf(this.objects.env, this.objects.repo, stagedWith, [id]),
      )) as CachedObject[];
      if (held?.kind === kind)
        return { bytes: this.records.encode(held), tier: 'store', filled: this.fill(held) };
    }
    // Accepted but not yet in R2: the authority still holds the staged copy. A staged copy
    // is dropped only after its R2 write, so a miss there means R2 has it now.
    const ofKind = (o: CachedObject | null | undefined) => (o?.kind === kind ? o : null);
    let object: CachedObject | null = ofKind(
      await timed('read.staged', () => this.records.staged(id, kind)),
    );
    object ??= await timed('read.raw', () => this.records.recorded(id, kind));
    // A fork's own store holds nothing its parent and R2 do not (and may still be forking).
    if (!object && !this.objects.inherited)
      object = await timed('read.store', async () => {
        if (kind === 'tree') {
          const entries = await this.objects.store.readTree(id);
          return entries && { id, kind, entries };
        }
        if (kind === 'blob') {
          const bytes = await this.objects.store.readBlob(id);
          return bytes && { id, kind, data_b64: toBase64(bytes) };
        }
        const commit = await this.objects.store.readCommit(id);
        return commit && { id, kind, ...commit };
      });
    // A fork's parent, every tier: before this repository's shards, since inherited
    // history is read far more often than this repository's not yet drained commits.
    const inherited =
      !object &&
      (await timed('read.parent', async () => this.objects.inherited?.bytes(id, kind, true)));
    if (inherited) return { bytes: inherited, tier: 'store', filled: Promise.resolve() };
    // Commit shards last: finding a staged object there means asking every shard, and
    if (!object) {
      this.#shards ??= new SharedShardAsk(this.objects.env, this.objects.repo);
      const shards = this.#shards;
      object = ofKind(await timed('read.shards', () => shards.get(id)));
      object ??= await timed('read.raw', () => this.records.recorded(id, kind));
    }
    if (!object) throw missing(`${kind[0].toUpperCase()}${kind.slice(1)} ${id}`);
    return { bytes: this.records.encode(object), tier: 'store', filled: this.fill(object) };
  }
}
