// What an import's fill reads of each commit: its file-level changes, from trees read straight
// from Artifacts over one handle (repo-import-fill.ts says why), each once in a wave.
import { NonRetryableError } from 'cloudflare:workflows';
import { rpcValue } from './durable';
import { compute } from './repo-compute';
import { inBatches } from './repo-git-objects';
import type { Commit } from './repo-import-fill';
import type { Json } from './repo-ops';
import type { TreeEntry } from './repo-stores';
import { TreeMemo } from './repo-tree-memo';
import type { Env } from './types';

/** Trees one commit reads at once. */
const READS = 16;
/** Parsed tree entries a wave keeps: a tree's child's is usually its parent's next. */
const TREE_ENTRIES = 200_000;

export type Repo = Awaited<ReturnType<Env['ARTIFACTS']['get']>>;

export const tooLarge = (e: any) => /^TOO_LARGE: /.test(String(e?.message));

/** A tree diff's changes as the authority records them. */
export const changedPaths = (changes: Json[]) =>
  changes.map((c) => ({
    path: c.path,
    op: c.op,
    old_blob: c.old?.id ?? null,
    new_blob: c.new?.id ?? null,
  }));

/** The wave's reads of `repo`: each tree once, however many commits ask at once. */
export function treeReader(repo: Repo) {
  const memo = new TreeMemo(TREE_ENTRIES);
  const reading = new Map<string, Promise<TreeEntry[]>>();
  const read = async (id: string) => {
    const entries = await rpcValue(repo.readTree(id));
    if (!entries) throw Object.assign(new Error(`Tree ${id} is missing`), { code: 'NOT_FOUND' });
    const tree = entries.map((e) => ({ name: e.name, type: e.type, id: e.hash }));
    memo.set('', id, tree);
    reading.delete(id);
    return tree;
  };
  return (id: string) => {
    const held = memo.get('', id) ?? reading.get(id);
    if (held) return held;
    const started = read(id);
    reading.set(id, started);
    return started;
  };
}

/** The file-level changes from tree `old` (null: nothing) to `tree`, as `withTrees` finds
 * them, starting from the two roots every diff needs. A commit no retry can record ends
 * the import, saying which limit it passed. */
export async function diff(read: ReturnType<typeof treeReader>, old: string | null, tree: string) {
  const trees: Record<string, TreeEntry[]> = {};
  let need = old ? [old, tree] : [tree];
  for (let round = 0; round <= 64; round++) {
    await inBatches(need, READS, async (id) => {
      trees[id] = await read(id);
    });
    let result: Json;
    try {
      result = compute({ op: 'tree_diff', old, new: tree, trees });
    } catch (e: any) {
      throw e?.code === 'TOO_LARGE' ? new NonRetryableError(`${e.code}: ${e.message}`) : e;
    }
    if (!result.need_trees) return changedPaths(result.changes);
    need = result.need_trees;
  }
  throw new NonRetryableError('INVALID_INPUT: Paths are nested too deeply');
}

/** The tree of `commit`'s first parent: `below` when the log says so, else its own read;
 * null for a root. */
export async function parentTree(repo: Repo, commit: Commit, below: Commit | undefined) {
  const parent = commit.parents[0];
  if (!parent) return null;
  if (below?.hash === parent) return below.tree;
  return (await rpcValue(repo.readCommit(parent)))?.treeHash ?? null;
}
