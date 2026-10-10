import type { Json } from './types';

type TreeEntry = { name: string; type: string; hash: string };
type GitRepository = {
  readCommit(hash: string): Promise<{ treeHash: string } | null>;
  readTree(hash: string): Promise<TreeEntry[] | null>;
};
type FileEntry = { blob: string; mode: string };
const MAX_PROVENANCE_TREE_FILES = 20_000;
const MAX_PROVENANCE_RECEIPTS = 10_000;

async function filesAt(repo: GitRepository, revision: string): Promise<Map<string, FileEntry>> {
  const commit = await repo.readCommit(revision);
  if (!commit) throw new Error('Provenance commit is missing');
  const files = new Map<string, FileEntry>();
  async function walk(tree: string, prefix: string, depth: number): Promise<void> {
    if (depth > 20) throw new Error('Provenance tree nesting exceeds limit');
    const entries = await repo.readTree(tree);
    if (!entries) throw new Error('Provenance tree is missing');
    for (const entry of entries) {
      if (
        !entry.name ||
        /[\\/\0:]/.test(entry.name) ||
        ['.', '..', '.git'].includes(entry.name.toLowerCase())
      )
        throw new Error('Provenance tree contains an unsafe path');
      const path = prefix + entry.name;
      if (entry.type === 'tree') {
        await walk(entry.hash, `${path}/`, depth + 1);
      } else if (entry.type === 'blob' || entry.type === 'exec') {
        if (!/^[0-9a-f]{40,64}$/i.test(entry.hash)) throw new Error('Invalid captured blob ID');
        files.set(path, { blob: entry.hash.toLowerCase(), mode: entry.type });
        if (files.size > MAX_PROVENANCE_TREE_FILES)
          throw new Error('Provenance tree exceeds the runtime safety limit');
      } else {
        throw new Error('Provenance supports regular files only');
      }
    }
  }
  await walk(commit.treeHash, '', 0);
  return files;
}

/** Derive per-file receipts from trusted Git trees; caller supplied blob IDs are never read. */
export async function captureFileProvenance(
  repo: GitRepository,
  baseCommit: string,
  capturedCommit: string,
  baseRepository: GitRepository = repo,
): Promise<Json[]> {
  const [before, after] = await Promise.all([
    filesAt(baseRepository, baseCommit),
    filesAt(repo, capturedCommit),
  ]);
  const removed = new Map(
    [...before].filter(([path, old]) => {
      const next = after.get(path);
      return !next || next.blob !== old.blob || next.mode !== old.mode;
    }),
  );
  const added = new Map(
    [...after].filter(([path, next]) => {
      const old = before.get(path);
      return !old || old.blob !== next.blob || old.mode !== next.mode;
    }),
  );

  // Git has no rename object. Pair only unique identical blob+mode moves; ambiguous
  // matches remain an explicit deletion and addition instead of guessed lineage.
  const removedByIdentity = new Map<string, string[]>();
  const addedByIdentity = new Map<string, string[]>();
  const identity = (entry: FileEntry) => `${entry.blob}:${entry.mode}`;
  for (const [path, entry] of removed)
    removedByIdentity.set(identity(entry), [
      ...(removedByIdentity.get(identity(entry)) ?? []),
      path,
    ]);
  for (const [path, entry] of added)
    addedByIdentity.set(identity(entry), [...(addedByIdentity.get(identity(entry)) ?? []), path]);

  const receipts: Json[] = [];
  const pairedOld = new Set<string>();
  const pairedNew = new Set<string>();
  for (const [key, oldPaths] of removedByIdentity) {
    const newPaths = addedByIdentity.get(key) ?? [];
    if (oldPaths.length === 1 && newPaths.length === 1) {
      const oldPath = oldPaths[0];
      const path = newPaths[0];
      receipts.push({
        path,
        old_path: oldPath,
        change: 'rename',
        old_blob: removed.get(oldPath)?.blob,
        new_blob: added.get(path)?.blob,
      });
      pairedOld.add(oldPath);
      pairedNew.add(path);
    }
  }
  for (const [path, old] of removed) {
    if (pairedOld.has(path)) continue;
    const next = after.get(path);
    if (next) {
      receipts.push({ path, change: 'modify', old_blob: old.blob, new_blob: next.blob });
      pairedNew.add(path);
    } else {
      receipts.push({ path, change: 'delete', old_blob: old.blob, new_blob: null });
    }
  }
  for (const [path, next] of added) {
    if (!pairedNew.has(path))
      receipts.push({ path, change: 'add', old_blob: null, new_blob: next.blob });
  }
  if (receipts.length > MAX_PROVENANCE_RECEIPTS)
    throw new Error('File provenance exceeds the receipt limit');
  return receipts.sort((a, b) => String(a.path).localeCompare(String(b.path)));
}

/** Validate optional context references against the assigned immutable source tree. */
export async function validateFilePathAssertions(
  repo: GitRepository,
  sourceCommit: string,
  paths: unknown,
): Promise<string[]> {
  if (!Array.isArray(paths) || paths.length > 32 || paths.some((path) => typeof path !== 'string'))
    throw new Error('File path assertions must be a bounded list of paths');
  const source = await filesAt(repo, sourceCommit);
  for (const path of paths as string[]) {
    if (
      !path ||
      path.startsWith('/') ||
      path.includes('\\') ||
      path
        .split('/')
        .some((part) => !part || part === '.' || part === '..' || part.toLowerCase() === '.git')
    )
      throw new Error('File path assertion is unsafe');
    if (!source.has(path))
      throw new Error(`File path assertion is absent from the assigned source: ${path}`);
  }
  return [...new Set(paths as string[])];
}
