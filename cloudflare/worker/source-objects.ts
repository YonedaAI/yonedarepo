// Immutable Git objects of a platform-backed project, read through the platform's public API
// (`/objects`, `/commits/:sha`, `/log`). Ids are Git ids, so reads never depend on when the
// platform projects its objects to any other store.
import { type ProjectPlatform, repositoryPlatform, revisionProject } from './agents-platform';
import type { Env, Json } from './types';

export type SourceEntryType = 'tree' | 'blob' | 'exec' | 'symlink' | 'gitlink';
export type SourceTreeEntry = { name: string; mode: string; hash: string; type: SourceEntryType };
export type SourceCommit = { hash: string; treeHash: string; parents: string[] };
export type SourceLogEntry = SourceCommit & { message: string; principal: string };
export interface SourceRepo {
  readonly repo: string;
  readCommit(hash: string): Promise<SourceCommit | null>;
  readTree(hash: string): Promise<SourceTreeEntry[] | null>;
  readBlob(hash: string): Promise<Blob | null>;
  /** First-parent history from a commit, newest first. */
  log(args: { ref: string; limit?: number; offset?: number }): Promise<SourceLogEntry[]>;
  /** Branch head, or null when the branch does not exist. */
  head(branch: string): Promise<string | null>;
}

const MODES: Record<SourceEntryType, string> = {
  tree: '40000',
  blob: '100644',
  exec: '100755',
  symlink: '120000',
  gitlink: '160000',
};
const SHA = /^[0-9a-f]{40}$/;

/** Many objects of one kind in request order, resuming past the platform's response budget. */
export async function readObjects(
  platform: ProjectPlatform,
  kind: 'tree' | 'blob' | 'commit',
  ids: string[],
): Promise<Map<string, Json>> {
  const found = new Map<string, Json>();
  const wanted = ids.map((id) => ({ id, kind }));
  for (let after = 0; after < wanted.length; ) {
    const page = await platform.call('POST', '/objects', { objects: wanted, after });
    for (const object of page.objects) found.set(object.id, object);
    if (page.next === null || page.next === undefined) break;
    after = page.next;
  }
  return found;
}

export function platformSource(platform: ProjectPlatform): SourceRepo {
  const one = async (kind: 'tree' | 'blob' | 'commit', id: string) =>
    SHA.test(id) ? ((await readObjects(platform, kind, [id])).get(id) ?? null) : null;
  return {
    repo: platform.repo,
    async readCommit(hash) {
      const commit = await one('commit', hash);
      return commit ? { hash, treeHash: commit.tree, parents: commit.parents } : null;
    },
    async readTree(hash) {
      const tree = await one('tree', hash);
      return tree
        ? tree.entries.map((e: Json) => ({
            name: e.name,
            hash: e.id,
            type: e.type,
            mode: MODES[e.type as SourceEntryType],
          }))
        : null;
    },
    async readBlob(hash) {
      const blob = await one('blob', hash);
      return blob ? new Blob([Uint8Array.from(atob(blob.data_b64), (c) => c.charCodeAt(0))]) : null;
    },
    async log({ ref, limit = 50, offset = 0 }) {
      const entries: SourceLogEntry[] = [];
      let next: string | undefined = ref;
      for (let index = 0; next && entries.length < limit; index++) {
        const commit = await platform.call('GET', `/commits/${next}`);
        if (index >= offset)
          entries.push({
            hash: commit.commit,
            treeHash: commit.tree,
            parents: commit.parents,
            message: commit.message,
            principal: commit.principal,
          });
        next = commit.parents[0];
      }
      return entries;
    },
    async head(branch) {
      const { refs } = await platform.call('GET', '/refs');
      return refs[`refs/heads/${branch}`] ?? null;
    },
  };
}

/** The source a revision names: always its own project's platform repository. */
export async function openSource(env: Env, repository: string): Promise<SourceRepo> {
  return platformSource(await repositoryPlatform(env, revisionProject(repository)));
}
