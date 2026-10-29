// The Git object stores behind repositories: Artifacts (production) or R2 (local
// development and the fallback the plan keeps open). Each repository records which one
// holds its objects; the tiered reads in front of them live in repo-objects.
import { rpcValue } from './durable';
import { compute } from './repo-compute';
import { largeReceivePack, putLarge } from './repo-large-files';
import { putObjects } from './repo-r2-writes';
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

// R2 writes of objects live in repo-r2-writes (re-exported for the object layer).
export {
  putBytes,
  putObjects,
  putRaw,
  putRawBytes,
  type RawObject,
} from './repo-r2-writes';

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
  /** Stores a file too large to hold (`size` bytes; `open` streams it from R2 again for
   * each attempt), reachable without a commit naming it yet: the hidden ref of a carrier
   * (repo-large-files `largeReceivePack`), whose commit id it answers, or none where the
   * store keeps objects without refs. */
  pushFile(
    id: string,
    size: number,
    open: () => Promise<ReadableStream<Uint8Array>>,
  ): Promise<string | null>;
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
/** Busy answers a large file's push waits out (Artifacts takes one receive-pack at once). */
const PUSH_FILE_RETRIES = 6;

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
  /**
   * Streams a large file's receive-pack straight to Artifacts (never through the push
   * queue: its body cannot be held or combined), retrying while Artifacts is busy with
   * another receive-pack and once with a fresh token.
   */
  async pushFile(id: string, size: number, open: () => Promise<ReadableStream<Uint8Array>>) {
    for (let attempt = 0; ; attempt++) {
      const { remote, token } = await this.credentials(attempt > 0);
      const { body, carrier } = largeReceivePack(id, size, await open());
      const result = await fetch(`${remote}/git-receive-pack`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/x-git-receive-pack-request',
          accept: 'application/x-git-receive-pack-result',
        },
        body,
        redirect: 'manual',
      });
      const report = new Uint8Array(await result.arrayBuffer());
      if ([401, 403].includes(result.status) && attempt === 0) continue;
      const busy = new TextDecoder().decode(report.subarray(0, 200)).includes('busy');
      if (busy && attempt < PUSH_FILE_RETRIES) {
        await new Promise((resolve) =>
          setTimeout(resolve, 100 * 2 ** attempt + Math.random() * 100),
        );
        continue;
      }
      if (result.status !== 200)
        throw Object.assign(new Error(`Object store push returned ${result.status}`), {
          code: 'PUSH_FAILED',
        });
      return carrier;
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
  /** A large file streamed into its object key (hidden refs are not kept here). */
  async pushFile(id: string, size: number, open: () => Promise<ReadableStream<Uint8Array>>) {
    await putLarge(this.env, this.key(id), size, await open());
    return null;
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
