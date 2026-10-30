// Objects as R2 entries, a repository's whole object store (local development and the
// fallback the plan keeps open): pushes are unpacked and verified by Rust compute.
import { compute } from './repo-compute';
import { putLarge } from './repo-large-files';
import { putObjects } from './repo-r2-writes';
import {
  type CommitHeader,
  fromBase64,
  type ObjectStore,
  type TreeEntry,
  toBase64,
} from './repo-stores';
import type { Env } from './types';

export class R2Store implements ObjectStore {
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
