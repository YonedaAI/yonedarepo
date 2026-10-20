// The Git object stores behind repositories: Artifacts (production) or R2 (local
// development and the fallback the plan keeps open). Each repository records which one
// holds its objects; the tiered reads in front of them live in repo-objects.
import { compute } from './repo-compute';
import { record, timed } from './repo-timing';
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
export type CommitHeader = { tree: string; parents: string[] };

export const fromBase64 = (value: string) => Uint8Array.from(atob(value), (c) => c.charCodeAt(0));
export function toBase64(bytes: Uint8Array) {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 8192)
    binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(binary);
}
/** The Git object store behind one repository. */
export interface ObjectStore {
  readonly spec: string;
  create(): Promise<void>;
  /** Accepts a receive-pack request body and returns Git's report-status. */
  push(body: Uint8Array): Promise<Uint8Array>;
  readCommit(id: string): Promise<CommitHeader | null>;
  readTree(id: string): Promise<TreeEntry[] | null>;
  readBlob(id: string): Promise<Uint8Array | null>;
  /** A read-only `git clone` remote and short-lived token, where the store supports it. */
  cloneAccess?(): Promise<{ remote: string; token: string; expires_in_seconds: number }>;
}

/** Per-isolate: a repository's remote never changes. */
const remotes = new Map<string, string>();
/** Per-isolate write tokens, reused until shortly before they expire (never logged). */
const tokens = new Map<string, { plaintext: string; expires: number }>();
const TOKEN_SECONDS = 60;
const TOKEN_REUSE_MS = 40_000;
const CLONE_TOKEN_SECONDS = 600;

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
  /**
   * Pushes through the repository's queue: Artifacts takes one receive-pack at a time. The
   * remote and a short-lived write token are reused within this isolate; minting and
   * revoking a token per push cost more than the push itself. A rejected token is replaced.
   */
  async push(body: Uint8Array) {
    const queue = this.env.OBJECT_PUSHES.get(this.env.OBJECT_PUSHES.idFromName(this.spec));
    for (let attempt = 0; ; attempt++) {
      const { remote, token } = await timed('push.token', () => this.credentials(attempt > 0));
      try {
        const pushed = await queue.push(remote, token, body);
        record('push.wait', pushed.waited_ms);
        record('push.send', pushed.sent_ms);
        record('push.batch', pushed.batch);
        return pushed.report;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (attempt === 0 && /returned 40[13]/.test(message)) continue;
        throw Object.assign(new Error(message), { code: 'PUSH_FAILED' });
      }
    }
  }
  private async credentials(fresh: boolean) {
    const cached = tokens.get(this.spec);
    const remote = remotes.get(this.spec);
    if (!fresh && remote && cached && cached.expires > Date.now())
      return { remote, token: cached.plaintext };
    using repo = await this.env.ARTIFACTS.get(this.name);
    const url = remote ?? (await repo.info()).remote;
    remotes.set(this.spec, url);
    const token = await repo.createToken('write', TOKEN_SECONDS);
    tokens.set(this.spec, { plaintext: token.plaintext, expires: Date.now() + TOKEN_REUSE_MS });
    return { remote: url, token: token.plaintext };
  }
  async cloneAccess() {
    using repo = await this.env.ARTIFACTS.get(this.name);
    const info = await repo.info();
    const token = await repo.createToken('read', CLONE_TOKEN_SECONDS);
    return { remote: info.remote, token: token.plaintext, expires_in_seconds: CLONE_TOKEN_SECONDS };
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
    // Hidden refs are not stored in R2 (objects never expire here): a delete is a no-op.
    if (received.delete)
      return fromBase64(compute({ op: 'push_report', refname: received.ref }).report_b64);
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

export function putObjects(env: Env, key: (id: string) => string, objects: CachedObject[]) {
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
