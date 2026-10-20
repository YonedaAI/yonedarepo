import { cacheSourceBlob } from './source-cache';
import { type SourceView, sourceError } from './source-contract';
import { sourceEntry, sourcePath, sourceRepo } from './source-path';
import type { Env } from './types';

/** Index metadata is rebuildable. Prove complete Git membership before first native binding/init. */
export async function verifySourceView(env: Env, view: SourceView, guard?: () => Promise<unknown>) {
  let operations = 0;
  let lastGuard = 0;
  const recheck = async (force = false) => {
    if (guard && (force || operations >= 16 || Date.now() - lastGuard >= 10000)) {
      await guard();
      operations = 0;
      lastGuard = Date.now();
    }
  };
  await recheck(true);
  const revision = view.base;
  const repo = await sourceRepo(env, revision);
  const root = await repo.readCommit(revision.commit);
  if (!root || root.hash !== revision.commit || root.treeHash !== revision.tree)
    throw sourceError('SOURCE_CHANGED', 'Prepared source root differs');
  const expected = new Map(view.files.map((file) => [file.path, file]));
  if (expected.size !== view.files.length || expected.size > 10000)
    throw sourceError('SOURCE_INDEX', 'Prepared source paths are not unique and bounded');
  const stack = [{ tree: revision.tree, path: '' }];
  let directories = 0;
  let bytes = 0;
  while (stack.length) {
    await recheck();
    operations++;
    if (++directories > 10000)
      throw sourceError('SOURCE_LIMIT', 'Prepared source directory count exceeds allowance');
    const frame = stack.pop();
    if (!frame) break;
    const entries = await repo.readTree(frame.tree);
    if (
      !entries ||
      entries.length > 10000 ||
      new Set(entries.map((entry) => entry.name)).size !== entries.length
    )
      throw sourceError('SOURCE_INDEX', 'Prepared source tree is missing or ambiguous');
    for (const entry of entries) {
      await recheck();
      operations++;
      sourceEntry(entry);
      const path = sourcePath(frame.path ? `${frame.path}/${entry.name}` : entry.name);
      if (entry.type === 'tree') {
        stack.push({ tree: entry.hash, path });
        continue;
      }
      const file = expected.get(path);
      if (
        !file ||
        file.mode !== entry.mode ||
        file.content.kind !== 'git' ||
        file.content.repository !== revision.repository ||
        file.content.commit !== revision.commit ||
        file.content.path !== path ||
        file.content.blob !== entry.hash
      )
        throw sourceError('SOURCE_INDEX', 'Prepared file is not linked at its frozen Git path');
      // Link is proven by the root traversal before any cached proof/body lookup.
      const proof = await cacheSourceBlob(env, repo, revision, entry.hash);
      if (proof.size !== file.size)
        throw sourceError('SOURCE_INDEX', 'Prepared source byte count differs');
      bytes += file.size;
      if (bytes > 100 * 1024 * 1024)
        throw sourceError('SOURCE_LIMIT', 'Prepared source exceeds byte allowance');
      expected.delete(path);
    }
  }
  if (expected.size)
    throw sourceError('SOURCE_INDEX', 'Prepared source contains files absent from the frozen root');
  await recheck(true);
}
