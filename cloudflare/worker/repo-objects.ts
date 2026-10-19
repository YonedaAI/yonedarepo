// Object access for the source platform. Each repository records which object store
// holds its Git objects: Artifacts (production) or R2 (local development and the
// fallback the plan keeps open). In front of either, R2 is the shared cache tier.
// Objects are immutable, so a cache entry keyed by id never needs invalidation; keys are
// per repository so access follows repository auth.
import { compute } from './repo-compute';
import type { Env } from './types';

export type TreeEntry = {
  name: string;
  type: 'tree' | 'blob' | 'exec' | 'symlink' | 'gitlink';
  id: string;
};
export type CachedObject =
  | { id: string; kind: 'tree'; entries: TreeEntry[] }
  | { id: string; kind: 'commit'; tree: string; parents: string[] }
  | { id: string; kind: 'blob'; data_b64: string };
type CommitHeader = { tree: string; parents: string[] };

export const fromBase64 = (value: string) => Uint8Array.from(atob(value), (c) => c.charCodeAt(0));
export function toBase64(bytes: Uint8Array) {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 8192)
    binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(binary);
}
const missing = (what: string) =>
  Object.assign(new Error(`${what} is missing`), { code: 'NOT_FOUND' });

/** The Git object store behind one repository. */
export interface ObjectStore {
  readonly spec: string;
  create(): Promise<void>;
  /** Accepts a receive-pack request body and returns Git's report-status. */
  push(body: Uint8Array): Promise<Uint8Array>;
  readCommit(id: string): Promise<CommitHeader | null>;
  readTree(id: string): Promise<TreeEntry[] | null>;
  readBlob(id: string): Promise<Uint8Array | null>;
}

class ArtifactsStore implements ObjectStore {
  constructor(
    private readonly env: Env,
    private readonly name: string,
  ) {}
  get spec() {
    return `artifacts:${this.env.ARTIFACTS_NAMESPACE}/${this.name}`;
  }
  async create() {
    await this.env.ARTIFACTS.create(this.name, { setDefaultBranch: 'main' });
  }
  async push(body: Uint8Array) {
    using repo = await this.env.ARTIFACTS.get(this.name);
    const info = await repo.info();
    const token = await repo.createToken('write', 60);
    try {
      const result = await fetch(`${info.remote}/git-receive-pack`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token.plaintext}`,
          'content-type': 'application/x-git-receive-pack-request',
          accept: 'application/x-git-receive-pack-result',
        },
        body,
        redirect: 'manual',
      });
      if (result.status !== 200)
        throw Object.assign(new Error(`Object store push returned ${result.status}`), {
          code: 'PUSH_FAILED',
        });
      return new Uint8Array(await result.arrayBuffer());
    } finally {
      await repo.revokeToken(token.id);
    }
  }
  async readCommit(id: string) {
    using repo = await this.env.ARTIFACTS.get(this.name);
    const commit = await repo.readCommit(id);
    return commit ? { tree: commit.treeHash, parents: commit.parents } : null;
  }
  async readTree(id: string) {
    using repo = await this.env.ARTIFACTS.get(this.name);
    const entries = await repo.readTree(id);
    return entries ? entries.map((e) => ({ name: e.name, type: e.type, id: e.hash })) : null;
  }
  async readBlob(id: string) {
    using repo = await this.env.ARTIFACTS.get(this.name);
    const blob = await repo.readBlob(id);
    return blob ? new Uint8Array(await blob.arrayBuffer()) : null;
  }
}

/** Objects as R2 entries; pushes are unpacked and verified by Rust compute. */
class R2Store implements ObjectStore {
  constructor(
    private readonly env: Env,
    private readonly name: string,
  ) {}
  get spec() {
    return `r2:${this.name}`;
  }
  private key(id: string) {
    return `store/v1/${this.name}/objects/${id}`;
  }
  async create() {}
  /** Like a Git server: store the pack, then update the ref only if `old` still holds. */
  async push(body: Uint8Array) {
    const received = compute({ op: 'receive_pack', body_b64: toBase64(body) });
    const refuse = (refused: string) =>
      fromBase64(compute({ op: 'push_report', refname: received.ref, refused }).report_b64);
    await putObjects(this.env, (id) => this.key(id), received.objects);
    if (!received.contains_new && !(await this.readCommit(received.new)))
      return refuse('missing necessary objects');
    // Hidden per-commit refs only keep objects reachable; R2 objects never expire.
    if (!received.ref.startsWith('refs/yoneda/')) {
      const key = `store/v1/${this.name}/${received.ref}`;
      const current = await this.env.OBJECTS.get(key);
      const value = current ? await current.text() : null;
      if (value !== (received.old ?? null)) return refuse('stale info');
      // Updates are conditional on the etag read above; creation is unconditional (R2 has
      // no create-only precondition), which only matters for two first projections racing.
      const written = await this.env.OBJECTS.put(
        key,
        received.new,
        current ? { onlyIf: { etagMatches: current.etag } } : {},
      );
      if (!written) return refuse('stale info');
    }
    return fromBase64(compute({ op: 'push_report', refname: received.ref }).report_b64);
  }
  /** A projected branch value (tests and drift investigation). */
  async readRef(refname: string) {
    const value = await this.env.OBJECTS.get(`store/v1/${this.name}/${refname}`);
    return value ? value.text() : null;
  }
  async readCommit(id: string) {
    const object = await this.env.OBJECTS.get(this.key(id));
    return object ? object.json<CommitHeader>() : null;
  }
  async readTree(id: string) {
    const object = await this.env.OBJECTS.get(this.key(id));
    return object ? (await object.json<{ entries: TreeEntry[] }>()).entries : null;
  }
  async readBlob(id: string) {
    const object = await this.env.OBJECTS.get(this.key(id));
    return object ? new Uint8Array(await object.arrayBuffer()) : null;
  }
}

function putObjects(env: Env, key: (id: string) => string, objects: CachedObject[]) {
  return Promise.all(
    objects.map((o) =>
      env.OBJECTS.put(key(o.id), o.kind === 'blob' ? fromBase64(o.data_b64) : JSON.stringify(o), {
        customMetadata: { kind: o.kind },
      }),
    ),
  );
}

/** A new repository's store, chosen by deployment (`PLATFORM_OBJECT_STORE=r2` locally). */
export function newStore(env: Env, name: string): ObjectStore {
  return env.PLATFORM_OBJECT_STORE === 'r2'
    ? new R2Store(env, name)
    : new ArtifactsStore(env, name);
}

/** Parses a recorded store: `artifacts:<namespace>/<name>` or `r2:<name>`. */
export function parseStore(env: Env, spec: string): ObjectStore {
  const artifacts = /^artifacts:([^/]+)\/([A-Za-z0-9._-]+)$/.exec(spec);
  if (artifacts && artifacts[1] === env.ARTIFACTS_NAMESPACE)
    return new ArtifactsStore(env, artifacts[2]);
  const r2 = /^r2:([A-Za-z0-9._-]+)$/.exec(spec);
  if (r2) return new R2Store(env, r2[1]);
  throw new Error('Repository object store is outside this deployment');
}

export type ObjectKind = 'tree' | 'blob' | 'commit';
/** Reads served per tier, for the S12 hit-rate gate: edge (Cache API), R2, object store. */
export type TierHits = { edge: number; r2: number; store: number };
const EDGE_ORIGIN = 'https://objects.yoneda.internal';

/**
 * Tiered, content-addressed reads: Cache API (per colo) -> R2 (shared) -> object store.
 * Each tier only asks the next one, and a miss fills the tiers above it. Keys carry the
 * repository so cached bytes are only reachable through that repository's auth.
 */
export class RepoObjects {
  readonly hits: TierHits = { edge: 0, r2: 0, store: 0 };
  constructor(
    private readonly env: Env,
    private readonly repo: string,
    readonly store: ObjectStore,
  ) {}

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

  async cache(objects: CachedObject[]) {
    await putObjects(this.env, (id) => this.key(id), objects);
    await Promise.all(
      objects.map((o) =>
        this.edgePut(o.id, o.kind, o.kind === 'blob' ? fromBase64(o.data_b64) : JSON.stringify(o)),
      ),
    );
  }

  /** Raw tier bytes for `id` (JSON for trees/commits, content for blobs). */
  private async read(id: string, kind: ObjectKind): Promise<Uint8Array> {
    const edge = await caches.default.match(this.edgeKey(id)).catch(() => undefined);
    if (edge && edge.headers.get('x-kind') === kind) {
      this.hits.edge++;
      return new Uint8Array(await edge.arrayBuffer());
    }
    const cached = await this.env.OBJECTS.get(this.key(id));
    if (cached && (cached.customMetadata?.kind ?? kind) === kind) {
      this.hits.r2++;
      const bytes = new Uint8Array(await cached.arrayBuffer());
      await this.edgePut(id, kind, bytes);
      return bytes;
    }
    this.hits.store++;
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
    if (!object) throw missing(`${kind[0].toUpperCase()}${kind.slice(1)} ${id}`);
    await this.cache([object]);
    return object.kind === 'blob'
      ? fromBase64(object.data_b64)
      : new TextEncoder().encode(JSON.stringify(object));
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

  /** Readback always asks the object store itself, never the cache. */
  async readback(id: string) {
    const commit = await this.store.readCommit(id);
    if (!commit)
      throw Object.assign(new Error('Pushed commit is not readable'), { code: 'PUSH_FAILED' });
    return commit;
  }

  push(body: Uint8Array) {
    return this.store.push(body);
  }
}
