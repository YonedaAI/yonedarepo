// The Git object stores behind repositories: Artifacts (production) or R2 (local
// development and the fallback the plan keeps open). Each repository records which one
// holds its objects; the tiered reads in front of them live in repo-objects.
import { rpcValue } from './durable';
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
  /** A fork's store: the parent repository and store its objects fall back to. */
  readonly inherits?: { repo: string; spec: string };
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
    await rpcValue(this.env.ARTIFACTS.create(this.name, { setDefaultBranch: 'main' }));
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
        const pushed = await rpcValue(queue.push(remote, token, body));
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
    const url = remote ?? (await rpcValue(repo.info())).remote;
    remotes.set(this.spec, url);
    const token = await rpcValue(repo.createToken('write', TOKEN_SECONDS));
    tokens.set(this.spec, { plaintext: token.plaintext, expires: Date.now() + TOKEN_REUSE_MS });
    return { remote: url, token: token.plaintext };
  }
  async cloneAccess() {
    using repo = await this.env.ARTIFACTS.get(this.name);
    const info = await rpcValue(repo.info());
    const token = await rpcValue(repo.createToken('read', CLONE_TOKEN_SECONDS));
    return { remote: info.remote, token: token.plaintext, expires_in_seconds: CLONE_TOKEN_SECONDS };
  }
  async readCommit(id: string) {
    using repo = await this.env.ARTIFACTS.get(this.name);
    const commit = await rpcValue(repo.readCommit(id));
    return commit ? { tree: commit.treeHash, parents: commit.parents } : null;
  }
  async readTree(id: string) {
    using repo = await this.env.ARTIFACTS.get(this.name);
    const entries = await rpcValue(repo.readTree(id));
    return entries ? entries.map((e) => ({ name: e.name, type: e.type, id: e.hash })) : null;
  }
  async readBlob(id: string) {
    using repo = await this.env.ARTIFACTS.get(this.name);
    return rpcValue(repo.readBlob(id), async (blob) =>
      blob ? new Uint8Array(await blob.arrayBuffer()) : null,
    );
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

/** R2 writes in flight in this isolate, and keys known written, by key. */
const writing = new Map<string, Promise<void>>();
const written = new Set<string>();
const WRITTEN_KEYS = 50_000;
const sameObjectBusy = (e: unknown) => /\b10058\b/.test(String((e as Error)?.message ?? e));
/** R2's transient internal (10001) and unavailable (10043) errors: the bytes are written again. */
const internalError = (e: unknown) => /\b100(01|43)\b/.test(String((e as Error)?.message ?? e));

/** A Git object's raw content (no header), as the store of record keeps it. */
export type RawObject = { id: string; kind: 'commit' | 'tree' | 'blob'; data_b64: string };

/**
 * Writes content-addressed objects. Concurrent commits write the same ids (a shared tree,
 * the same blob), and R2 allows one write per key at a time (10058): a write already in
 * flight here is joined, a key written here is skipped, and a 10058 counts as written
 * once the object is readable (another writer holds identical bytes), else it is retried.
 * R2's transient internal (10001) and unavailable (10043) errors are retried the same way.
 */
export function putObjects(env: Env, key: (id: string) => string, objects: CachedObject[]) {
  return Promise.all(
    objects.map((o) =>
      writeOnce(env, key(o.id), o.kind, () =>
        o.kind === 'blob' ? fromBase64(o.data_b64) : JSON.stringify(o),
      ),
    ),
  );
}

/** Raw objects into the store of record; each write is confirmed by its stored size. */
export function putRaw(env: Env, key: (id: string) => string, objects: RawObject[]) {
  return Promise.all(
    objects.map((o) => writeOnce(env, key(o.id), o.kind, () => fromBase64(o.data_b64))),
  );
}

/** Raw objects given as bytes (a push's verified objects), written like `putRaw`. */
export function putRawBytes(
  env: Env,
  key: (id: string) => string,
  objects: { id: string; kind: string; data: Uint8Array }[],
) {
  return Promise.all(objects.map((o) => writeOnce(env, key(o.id), o.kind, () => o.data)));
}

/** One object under `key` (a push's bundle), written like `putRaw`. */
export function putBytes(env: Env, key: string, kind: string, body: Uint8Array) {
  return writeOnce(env, key, kind, () => body);
}

function writeOnce(env: Env, key: string, kind: string, body: () => Uint8Array | string) {
  if (written.has(key)) return Promise.resolve();
  let write = writing.get(key);
  if (!write) {
    write = putOnce(env, key, kind, body()).finally(() => writing.delete(key));
    writing.set(key, write);
  }
  return write;
}

async function putOnce(env: Env, key: string, kind: string, body: Uint8Array | string) {
  const size = typeof body === 'string' ? new TextEncoder().encode(body).length : body.length;
  for (let attempt = 0; ; attempt++) {
    try {
      const stored = await env.OBJECTS.put(key, body, { customMetadata: { kind } });
      if (stored && stored.size !== size)
        throw Object.assign(new Error(`R2 stored ${stored.size} of ${size} bytes for ${key}`), {
          code: 'STORE_MISMATCH',
        });
      break;
    } catch (e) {
      const busy = sameObjectBusy(e);
      if ((!busy && !internalError(e)) || attempt >= 3) throw e;
      if (busy && (await env.OBJECTS.head(key))) break;
      await new Promise((resolve) => setTimeout(resolve, 200 * (attempt + 1)));
    }
  }
  if (written.size >= WRITTEN_KEYS) written.clear();
  written.add(key);
}

/** A new repository's store, chosen by deployment (`PLATFORM_OBJECT_STORE=r2` locally). */
export function newStore(env: Env, name: string): ObjectStore {
  return env.PLATFORM_OBJECT_STORE === 'r2'
    ? new R2Store(env, name)
    : new ArtifactsStore(env, name);
}

/**
 * A fork's own store, named `name`: an Artifacts fork of the parent's own store when that
 * is Artifacts (it then holds the parent's projected branches: `inherited`), else a new,
 * empty store of this deployment's kind.
 */
export async function forkStore(env: Env, parentSpec: string, name: string) {
  const parent = /^artifacts:([^/]+)\/([A-Za-z0-9._-]+)$/.exec(ownSpec(parentSpec));
  if (parent && parent[1] === env.ARTIFACTS_NAMESPACE && env.PLATFORM_OBJECT_STORE !== 'r2') {
    using repo = await env.ARTIFACTS.get(parent[2]);
    // The fork's initial write token stays here and is dropped, as for create().
    await rpcValue(repo.fork(name, { defaultBranchOnly: false }));
    return { spec: new ArtifactsStore(env, name).spec, inherited: true };
  }
  const store = newStore(env, name);
  await store.create();
  return { spec: store.spec, inherited: false };
}

/** Forks of forks nest their parents' specs; this many levels at most. */
export const FORK_DEPTH = 4;
const FORK = /^fork:/;

/** A fork's store spec: its own store and its parent's (repository and spec), whose
 * objects it inherits (repo-objects reads fall back to them; nothing is copied). */
export function forkSpec(parent: string, parentSpec: string, own: string) {
  return `fork:${JSON.stringify({ parent, store: parentSpec, own })}`;
}

/** How many fork levels `spec` nests (0: not a fork). */
export const forkDepth = (spec: string) => spec.match(/fork:/g)?.length ?? 0;

/** The store a repository writes and purges: a fork's own, never its parent's. */
export function ownSpec(spec: string): string {
  return FORK.test(spec) ? String(JSON.parse(spec.slice(5)).own) : spec;
}

/** Parses a recorded store: `artifacts:<namespace>/<name>`, `r2:<name>`, or a fork's
 * (`forkSpec`): its own store, carrying the parent it inherits from. */
export function parseStore(env: Env, spec: string): ObjectStore {
  if (FORK.test(spec)) {
    const fork = JSON.parse(spec.slice(5));
    if (!/^r[0-9a-f]{20}$/.test(fork.parent) || forkDepth(spec) > FORK_DEPTH || FORK.test(fork.own))
      throw new Error('Repository object store is not a valid fork');
    const own = parseStore(env, fork.own);
    return Object.assign(own, { inherits: { repo: fork.parent, spec: String(fork.store) } });
  }
  const artifacts = /^artifacts:([^/]+)\/([A-Za-z0-9._-]+)$/.exec(spec);
  if (artifacts && artifacts[1] === env.ARTIFACTS_NAMESPACE)
    return new ArtifactsStore(env, artifacts[2]);
  const r2 = /^r2:([A-Za-z0-9._-]+)$/.exec(spec);
  if (r2) return new R2Store(env, r2[1]);
  throw new Error('Repository object store is outside this deployment');
}
