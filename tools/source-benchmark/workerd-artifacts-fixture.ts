import { createHash } from 'node:crypto';
import { fixtureBytes, fixturePaths, requestedPaths } from './content.mjs';

const seed = 'yoneda-source-api-v1';
const bytesPerFile = 4096;
const oid = (kind: string, bytes: Uint8Array) =>
  createHash('sha1').update(`${kind} ${bytes.length}\0`).update(bytes).digest('hex');

/** External Artifacts fixture only: native staging and R2 remain actual Workerd bindings. */
export function artifactsBenchmarkFixture() {
  const paths: string[] = fixturePaths(10000);
  const requested: string[] = requestedPaths(paths);
  const byBlob = new Map<string, string>();
  const trees = new Map<string, ArtifactsTreeEntry[]>();
  function tree(entries: { name: string; mode: string; hash: string; type: string }[]) {
    entries.sort((a, b) => a.name.localeCompare(b.name));
    const content = Buffer.concat(
      entries.map((entry) =>
        Buffer.concat([
          Buffer.from(`${entry.type === 'tree' ? '40000' : entry.mode} ${entry.name}\0`),
          Buffer.from(entry.hash, 'hex'),
        ]),
      ),
    );
    const hash = oid('tree', content);
    trees.set(hash, entries as ArtifactsTreeEntry[]);
    return hash;
  }
  const folders = new Map<string, { name: string; mode: string; hash: string; type: string }[]>();
  for (const path of paths) {
    const [, folder, name] = path.split('/');
    const blob = oid('blob', fixtureBytes(seed, path, bytesPerFile));
    byBlob.set(blob, path);
    const entries = folders.get(folder) ?? [];
    entries.push({ name, mode: '100644', type: 'blob', hash: blob });
    folders.set(folder, entries);
  }
  const data = tree(
    [...folders].map(([name, entries]) => ({
      name,
      mode: '040000',
      type: 'tree',
      hash: tree(entries),
    })),
  );
  const root = tree([{ name: 'data', mode: '040000', type: 'tree', hash: data }]);
  const base = {
    repository: 'yoneda-test/source-base',
    commit: '07eddbc5fac77839cf101342767a2f825d19c53b',
    tree: root,
  };
  const reads: string[] = [];
  let treeReads = 0,
    commitReads = 0;
  const repo = {
    [Symbol.dispose]() {},
    async readCommit(commit: string) {
      if (commit !== base.commit) throw new Error('Unexpected history or foreign commit read');
      commitReads++;
      return { hash: commit, treeHash: root };
    },
    async readTree(hash: string) {
      const entries = trees.get(hash);
      if (!entries) throw new Error('Foreign source tree');
      treeReads++;
      return entries.map((entry) => ({ ...entry }));
    },
    async readBlob(blob: string) {
      const path = byBlob.get(blob);
      if (!path) throw new Error('Foreign source blob');
      reads.push(path);
      return new Blob([fixtureBytes(seed, path, bytesPerFile)]);
    },
  } as unknown as ArtifactsRepo;
  const artifacts = {
    async get(name: string) {
      if (name !== 'source-base') throw new Error('Foreign source repository');
      return repo;
    },
  } as unknown as Artifacts;
  return {
    base,
    paths,
    requested,
    reads,
    repo,
    artifacts,
    counts: () => ({
      tree_reads: treeReads,
      commit_reads: commitReads,
      blob_reads: reads.length,
      blob_bytes: reads.length * bytesPerFile,
    }),
  };
}
