// Object access for the source platform: R2 is the shared cache tier in front of
// Artifacts (the Git object store). Objects are immutable, so a cache entry keyed by id
// never needs invalidation; keys are per repository so access follows repository auth.
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

export const fromBase64 = (value: string) => Uint8Array.from(atob(value), (c) => c.charCodeAt(0));
export function toBase64(bytes: Uint8Array) {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 8192)
    binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(binary);
}

export class RepoObjects {
  constructor(
    private readonly env: Env,
    private readonly repo: string,
    private readonly store: string,
  ) {}

  /** `artifacts:<namespace>/<name>` as recorded in the repository settings. */
  static parseStore(env: Env, objectStore: string) {
    const match = /^artifacts:([^/]+)\/([A-Za-z0-9._-]+)$/.exec(objectStore);
    if (!match || match[1] !== env.ARTIFACTS_NAMESPACE)
      throw new Error('Repository object store is outside this namespace');
    return match[2];
  }

  private key(id: string) {
    return `platform/v1/${this.repo}/objects/${id}`;
  }

  async cache(objects: CachedObject[]) {
    await Promise.all(
      objects.map((o) =>
        this.env.OBJECTS.put(
          this.key(o.id),
          o.kind === 'blob' ? fromBase64(o.data_b64) : JSON.stringify(o),
          { customMetadata: { kind: o.kind } },
        ),
      ),
    );
  }

  async tree(id: string): Promise<TreeEntry[]> {
    const cached = await this.env.OBJECTS.get(this.key(id));
    if (cached) return (await cached.json<{ entries: TreeEntry[] }>()).entries;
    using repo = await this.env.ARTIFACTS.get(this.store);
    const entries = await repo.readTree(id);
    if (!entries) throw Object.assign(new Error(`Tree ${id} is missing`), { code: 'NOT_FOUND' });
    const listed = entries.map((e) => ({ name: e.name, type: e.type, id: e.hash }));
    await this.cache([{ id, kind: 'tree', entries: listed }]);
    return listed;
  }

  async blob(id: string): Promise<Uint8Array> {
    const cached = await this.env.OBJECTS.get(this.key(id));
    if (cached) return new Uint8Array(await cached.arrayBuffer());
    using repo = await this.env.ARTIFACTS.get(this.store);
    const blob = await repo.readBlob(id);
    if (!blob) throw Object.assign(new Error(`Blob ${id} is missing`), { code: 'NOT_FOUND' });
    const bytes = new Uint8Array(await blob.arrayBuffer());
    await this.cache([{ id, kind: 'blob', data_b64: toBase64(bytes) }]);
    return bytes;
  }

  /** Readback always asks the object store itself, never the cache. */
  async readback(id: string) {
    using repo = await this.env.ARTIFACTS.get(this.store);
    const commit = await repo.readCommit(id);
    if (!commit)
      throw Object.assign(new Error('Pushed commit is not readable'), { code: 'PUSH_FAILED' });
    return { tree: commit.treeHash, parents: commit.parents };
  }

  /** Sends a server-built receive-pack request; the Rust authority verifies the report. */
  async push(body: Uint8Array): Promise<Uint8Array> {
    using repo = await this.env.ARTIFACTS.get(this.store);
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
}
