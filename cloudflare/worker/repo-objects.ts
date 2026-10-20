// Object access for the source platform: tiered reads (edge, R2) in front of each
// repository's object store (repo-stores), and verified pushes to it. Objects are
// immutable, so a cache entry keyed by id never needs invalidation; keys are per
// repository so access follows repository auth.
import { compute } from './repo-compute';
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

const PUSH_ATTEMPTS = 5;
const CACHE_CHUNK = 256;
/** Commits up to this many objects write the cache alongside their push. */
export const OVERLAP_CACHE_OBJECTS = 64;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const accepted = (refname: string) =>
  fromBase64(compute({ op: 'push_report', refname }).report_b64);
/** Git's report-status for one ref; anything else (an unpack failure, a server error line)
 * is a refusal carrying the report's printable text. */
function pushOutcome(report: Uint8Array, refname: string): { accepted: boolean; refused?: string } {
  try {
    const outcome = compute({ op: 'push_outcome', refname, report_b64: toBase64(report) });
    return { accepted: outcome.accepted === true, refused: outcome.refused ?? undefined };
  } catch {
    const text = new TextDecoder().decode(report).replace(/[^\x20-\x7e]+/g, ' ');
    return { accepted: false, refused: text.trim().slice(0, 300) || 'empty report' };
  }
}
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
 * Tiered, content-addressed reads: Cache API (per colo) -> R2 (shared) -> object store.
 * Each tier only asks the next one, and a miss fills the tiers above it. Keys carry the
 * repository so cached bytes are only reachable through that repository's auth.
 */
export class RepoObjects {
  readonly hits: TierHits = { edge: 0, r2: 0, store: 0 };
  constructor(
    readonly env: Env,
    private readonly repo: string,
    readonly store: ObjectStore,
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
  private async read(id: string, kind: ObjectKind): Promise<Uint8Array> {
    const key = `${this.repo}/${kind}/${id}`;
    let reading = inFlight.get(key);
    if (!reading) {
      reading = this.walk(id, kind).finally(() => inFlight.delete(key));
      inFlight.set(key, reading);
    }
    const { bytes, tier } = await reading;
    this.hits[tier]++;
    return bytes;
  }

  private async walk(id: string, kind: ObjectKind): Promise<{ bytes: Uint8Array; tier: Tier }> {
    const edge = await caches.default.match(this.edgeKey(id)).catch(() => undefined);
    if (edge && edge.headers.get('x-kind') === kind)
      return { bytes: new Uint8Array(await edge.arrayBuffer()), tier: 'edge' };
    const cached = await this.env.OBJECTS.get(this.key(id));
    if (cached && (cached.customMetadata?.kind ?? kind) === kind) {
      const bytes = new Uint8Array(await cached.arrayBuffer());
      await this.edgePut(id, kind, bytes);
      return { bytes, tier: 'r2' };
    }
    const raw = await this.env.OBJECTS.get(this.rawKey(id));
    if (raw && raw.customMetadata?.kind === kind) {
      const data_b64 = toBase64(new Uint8Array(await raw.arrayBuffer()));
      const [object] = compute({ op: 'parse_objects', objects: [{ id, kind, data_b64 }] })
        .objects as CachedObject[];
      await this.cache([object]);
      return { bytes: this.encode(object), tier: 'r2' };
    }
    let object: CachedObject | null = null;
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
    // Accepted but not yet projected: the authority still holds the staged copy.
    object ??= await this.staged(id).then((o) => (o?.kind === kind ? o : null));
    if (!object) throw missing(`${kind[0].toUpperCase()}${kind.slice(1)} ${id}`);
    await this.cache([object]);
    return { bytes: this.encode(object), tier: 'store' };
  }

  private encode(object: CachedObject) {
    return object.kind === 'blob'
      ? fromBase64(object.data_b64)
      : new TextEncoder().encode(JSON.stringify(object));
  }

  /**
   * Raw content of objects for a pack: the store of record (R2), then the authority's
   * staged copy for objects still in flight. Missing ones are left out.
   */
  async raw(wanted: { id: string; kind: string }[]): Promise<RawObject[]> {
    const found: RawObject[] = [];
    const absent: { id: string; kind: string }[] = [];
    for (let i = 0; i < wanted.length; i += CACHE_CHUNK) {
      await Promise.all(
        wanted.slice(i, i + CACHE_CHUNK).map(async (w) => {
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
      found.push(...((await this.stagedCall({ ids, raw: true })) as RawObject[]));
    }
    return found;
  }

  /** The authority's staged copy of an accepted object (read as the platform: callers
   * reach this tier only through the same authorization as the object store). */
  private async staged(id: string): Promise<CachedObject | null> {
    return ((await this.stagedCall({ ids: [id] })) as CachedObject[])[0] ?? null;
  }

  private async stagedCall(args: { ids: string[]; raw?: true }): Promise<unknown[]> {
    const stub = this.env.SOURCE_REPOS.get(this.env.SOURCE_REPOS.idFromName(this.repo));
    const response = await stub.fetch('https://source-repository/', {
      method: 'POST',
      body: JSON.stringify({ op: 'repo_staged_objects', ...args, _system: 'projection' }),
    });
    const value = await response.json<{
      objects?: unknown[];
      error?: { code: string; message: string };
    }>();
    if (value.error)
      throw Object.assign(new Error(value.error.message), { code: value.error.code });
    return value.objects ?? [];
  }

  async tree(id: string): Promise<TreeEntry[]> {
    const bytes = await this.read(id, 'tree');
    return (JSON.parse(new TextDecoder().decode(bytes)) as { entries: TreeEntry[] }).entries;
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

  /**
   * Pushes a commit's pack to its hidden ref and reads the commit back from the object store
   * itself, never the cache. Artifacts can refuse or lag pushes when several land on one
   * repository at once, so a refusal is retried with jittered backoff and a missing readback
   * is re-read before the push counts as failed. Pushes are idempotent: same objects, same
   * hidden ref. `ready` (the cache write running alongside) settles before the readback.
   */
  async pushCommit(body: Uint8Array, commit: string, ready: Promise<unknown> = Promise.resolve()) {
    const refname = `refs/yoneda/c/${commit}`;
    ready.catch(() => {}); // observed below; a push failure must not leave it unhandled
    let reason = 'not readable';
    for (let attempt = 0; attempt < PUSH_ATTEMPTS; attempt++) {
      if (attempt) await sleep(100 * 2 ** attempt + Math.random() * 100 * 2 ** attempt);
      const report = await timed('push.store', () => this.store.push(body));
      const outcome = pushOutcome(report, refname);
      if (!outcome.accepted) {
        reason = `refused: ${outcome.refused}`;
        console.warn(`object store push attempt ${attempt + 1} ${reason}`);
      }
      await ready;
      for (let read = 0; read < 3; read++) {
        const readback = await timed('push.readback', () => this.store.readCommit(commit));
        // A retried push may be refused because an earlier attempt already created the ref.
        if (readback) return { report: outcome.accepted ? report : accepted(refname), readback };
        if (!outcome.accepted) break;
        await sleep(50 * 2 ** read);
      }
    }
    throw Object.assign(new Error(`Pushed commit is not readable (${reason})`), {
      code: 'PUSH_FAILED',
    });
  }

  push(body: Uint8Array) {
    return this.store.push(body);
  }
}
