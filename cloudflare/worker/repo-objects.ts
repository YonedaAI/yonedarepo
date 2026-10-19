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
  async push(body: Uint8Array) {
    const received = compute({ op: 'receive_pack', body_b64: toBase64(body) });
    await putObjects(this.env, (id) => this.key(id), received.objects);
    return fromBase64(received.report_b64);
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

export class RepoObjects {
  constructor(
    private readonly env: Env,
    private readonly repo: string,
    readonly store: ObjectStore,
  ) {}

  private key(id: string) {
    return `platform/v1/${this.repo}/objects/${id}`;
  }

  cache(objects: CachedObject[]) {
    return putObjects(this.env, (id) => this.key(id), objects);
  }

  async tree(id: string): Promise<TreeEntry[]> {
    const cached = await this.env.OBJECTS.get(this.key(id));
    if (cached) return (await cached.json<{ entries: TreeEntry[] }>()).entries;
    const entries = await this.store.readTree(id);
    if (!entries) throw missing(`Tree ${id}`);
    await this.cache([{ id, kind: 'tree', entries }]);
    return entries;
  }

  async blob(id: string): Promise<Uint8Array> {
    const cached = await this.env.OBJECTS.get(this.key(id));
    if (cached) return new Uint8Array(await cached.arrayBuffer());
    const bytes = await this.store.readBlob(id);
    if (!bytes) throw missing(`Blob ${id}`);
    await this.cache([{ id, kind: 'blob', data_b64: toBase64(bytes) }]);
    return bytes;
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
