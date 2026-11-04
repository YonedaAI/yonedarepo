// Repository object access: quarantine and fork boundaries, tree memory and verified
// pushes. Tier traversal and recorded/bundled pack reads each have a focused adapter.
import type { DurableFlightOwner } from './flights';
import { edgePut } from './repo-cache-tiers';
import { Inherited } from './repo-inherit';
import { type ObjectKind, ObjectRecords } from './repo-object-records';
import { ObjectReader, type TierHits } from './repo-object-tiers';
import { quarantined, type Withheld, withheldMap } from './repo-quarantine-guard';
import {
  type CachedObject,
  fromBase64,
  type ObjectStore,
  parseStore,
  putObjects,
  type TreeEntry,
  toBase64,
} from './repo-stores';
import { timed } from './repo-timing';
import { isolateTrees, type TreeMemo } from './repo-tree-memo';
import type { Env } from './types';

export { gitObjectId, type ObjectKind } from './repo-object-records';
export type { TierHits } from './repo-object-tiers';
// Stores and object forms, for callers that know this module as the object layer.
export {
  type CachedObject,
  fromBase64,
  type ObjectStore,
  parseStore,
  type TreeEntry,
  toBase64,
} from './repo-stores';

const CACHE_CHUNK = 256;
/** Commits up to this many objects write the cache alongside their push. */
export const OVERLAP_CACHE_OBJECTS = 64;

/** Immutable objects are reachable only through the repository's access decision. */
export class RepoObjects {
  readonly hits: TierHits;
  /** Blobs this repository withholds (quarantine), by id, with the path the owner named:
   * set from the access answer that authorized the request (`withhold`). */
  private withheld: Withheld = new Map();
  /** A store adopted from a commit has no access answer; RepoContext must fetch one. */
  knowsWithheld = false;
  readonly inherited?: Inherited;
  readonly #records: ObjectRecords;
  readonly #reader: ObjectReader;
  /** Bulk locations found absent from bundles; read their individual R2 keys directly. */
  readonly unbundled = new Set<string>();

  constructor(
    readonly env: Env,
    readonly repo: string,
    readonly store: ObjectStore,
    private readonly trees: TreeMemo = isolateTrees,
    owner?: DurableFlightOwner,
  ) {
    const parent = store.inherits;
    if (parent)
      this.inherited = new Inherited(
        new RepoObjects(env, parent.repo, parseStore(env, parent.spec), trees, owner),
      );
    this.#records = new ObjectRecords(env, repo, this.inherited, this.unbundled);
    this.#reader = new ObjectReader(this, this.#records, owner);
    this.hits = this.#reader.hits;
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

  rawKey(id: string) {
    return this.#records.rawKey(id);
  }
  key(id: string) {
    return this.#records.key(id);
  }
  recorded(id: string, kind: ObjectKind) {
    return this.#records.recorded(id, kind);
  }
  encode(object: CachedObject) {
    return this.#records.encode(object);
  }
  raw(
    asked: { id: string; kind: string }[],
    owners?: Map<string, string>,
    large?: Map<string, number>,
  ) {
    return this.#records.raw(asked, owners, large);
  }
  stored(wanted: { id: string; kind: string }[], large?: Map<string, number>) {
    return this.#records.stored(wanted, large);
  }

  /** Quarantine is checked before a blob can join any pending read or hit any tier. */
  async read(id: string, kind: ObjectKind, stagedWith?: string): Promise<Uint8Array> {
    if (kind === 'blob') await this.refuse(id);
    return this.#reader.read(id, kind, stagedWith);
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
