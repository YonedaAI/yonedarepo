// The object store of a repository with no mirror (its Artifacts mirror retired after a
// purge, repo-mirror-retire; or a fork of such a repository): the platform's own store of
// record is all there is. Reads find nothing here that the tiers in front of a store
// (repo-objects: R2's raw copies and bundles) did not; a commit too large to stage is
// written there whole (repo-pack-copy), withheld blobs never. There is no `git clone`
// remote: clones are served by the platform's Git over HTTPS.

import { fromBundles } from './repo-bundles';
import { compute } from './repo-compute';
import { withheldOf } from './repo-head';
import { putLarge } from './repo-large-files';
import { PackCopy } from './repo-pack-copy';
import { withheldMap } from './repo-quarantine-guard';
import { type CommitHeader, fromBase64, type ObjectStore, type TreeEntry } from './repo-stores';
import type { Env } from './types';

export const PLATFORM_SPEC = /^platform:([A-Za-z0-9._-]+)$/;

/** The raw content key of the store of record (as `RepoObjects.rawKey`). */
const rawKey = (repo: string) => (id: string) => `platform/v1/${repo}/git/${id}`;

export class PlatformStore implements ObjectStore {
  constructor(
    private readonly env: Env,
    readonly repo: string,
  ) {}
  get spec() {
    return `platform:${this.repo}`;
  }
  async create() {}
  /** A receive-pack request (a prepared commit's): its pack written to the store of
   * record, then Git's report for its ref. */
  async push(body: Uint8Array) {
    const withheld = new Set(withheldMap(await withheldOf(this.env, this.repo)).keys());
    const copy = new PackCopy(this.env, this.repo, rawKey(this.repo), withheld);
    try {
      await copy.feed(body);
      const { refs } = await copy.store();
      return fromBase64(compute({ op: 'push_report', refname: refs[0] }).report_b64);
    } finally {
      await copy.close();
    }
  }
  /** A large file streamed into its raw key (hidden refs are not kept here). */
  async pushFile(id: string, size: number, open: () => Promise<ReadableStream<Uint8Array>>) {
    await putLarge(this.env, rawKey(this.repo)(id), size, await open());
    return null;
  }
  /** A commit's tree and parents from the store of record (a push's readback). */
  async readCommit(id: string): Promise<CommitHeader | null> {
    const raw = await this.env.OBJECTS.get(rawKey(this.repo)(id));
    const bytes = raw
      ? new Uint8Array(await raw.arrayBuffer())
      : (await fromBundles(this.env, this.repo, [{ id, kind: 'commit' }])).get(id);
    if (!bytes) return null;
    const head = new TextDecoder().decode(bytes).split('\n\n')[0].split('\n');
    const tree = head.find((l) => l.startsWith('tree '))?.slice(5);
    const parents = head.filter((l) => l.startsWith('parent ')).map((l) => l.slice(7));
    return tree ? { tree, parents } : null;
  }
  async readTree(_id: string): Promise<TreeEntry[] | null> {
    return null;
  }
  async readBlob(_id: string): Promise<Uint8Array | null> {
    return null;
  }
}
