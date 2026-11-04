// Recorded Git bytes, bundled/staged locations and bounded pack reads. Callers authorize
// access before reaching this layer; a fork keeps inherited objects under its parent's keys.
import { type Location, platformCall, readBundled, readKnown, SMALL_RANGE } from './repo-bundles';
import { compute } from './repo-compute';
import type { Inherited } from './repo-inherit';
import { SPILL_BYTES, tooLarge } from './repo-large-files';
import { stagedInShards, stagedWithCommits } from './repo-shard-reads';
import { type CachedObject, fromBase64, type RawObject, toBase64 } from './repo-stores';
import type { Env } from './types';

const CACHE_CHUNK = 256;
export type ObjectKind = 'tree' | 'blob' | 'commit';

/** A Git object's id: SHA-1 of `<kind> <size>\0` and its content. */
export async function gitObjectId(kind: string, data: Uint8Array) {
  const header = new TextEncoder().encode(`${kind} ${data.length}\0`);
  const whole = new Uint8Array(header.length + data.length);
  whole.set(header);
  whole.set(data, header.length);
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-1', whole));
  return [...digest].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** One repository's store-of-record and accepted-but-not-yet-drained objects. */
export class ObjectRecords {
  constructor(
    readonly env: Env,
    readonly repo: string,
    readonly inherited: Inherited | undefined,
    readonly unbundled: Set<string>,
  ) {}

  /** The store of record: raw Git content of platform-built objects, never deleted. */
  rawKey(id: string) {
    return `platform/v1/${this.repo}/git/${id}`;
  }
  /** The cache tier key (also read by a fork, repo-inherit). */
  key(id: string) {
    return `platform/v1/${this.repo}/objects/${id}`;
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
   * then the authority's staged copy or bundle location for objects still missing, a fork's
   * parent's every tier (before its shards unless `owners` says an object is staged here:
   * what no commit names is far more likely inherited, and one busy shard of 64 would fail
   * every object they do not hold), and the commit shards (once for all; `owners` names the
   * commit an object was staged with, so only its shard is asked). Missing ones are left
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
    if (!owners)
      for (const o of (await this.inherited?.raw(missing(wanted), true)) ?? []) found.set(o.id, o);
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
    const bundled = await readBundled(
      this.env,
      this.repo,
      wanted.filter((w) => !this.unbundled.has(w.id)),
      SMALL_RANGE,
    );
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
  async staged(id: string, kind: ObjectKind): Promise<CachedObject | null> {
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
}
