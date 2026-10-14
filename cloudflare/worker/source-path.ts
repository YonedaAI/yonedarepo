import { safeId } from './http';
import { SOURCE_LIMITS, type SourceRevision, sourceError } from './source-contract';
import type { Env } from './types';

export function sourcePath(path: unknown, root = false): string {
  if (root && path === '') return '';
  if (
    typeof path !== 'string' ||
    !path.isWellFormed() ||
    new TextEncoder().encode(path).length > 512 ||
    !path ||
    /[\\\0:]/.test(path) ||
    path.split('/').some((part) => !part || ['.', '..', '.git'].includes(part.toLowerCase()))
  )
    throw sourceError('SOURCE_PATH', 'Source paths must be safe relative regular-file paths');
  return path;
}

/** Rust orders valid paths by UTF-8 bytes; UTF-16 JavaScript comparison differs above U+FFFF. */
export function compareSourcePaths(a: string, b: string) {
  let left = 0;
  let right = 0;
  while (left < a.length && right < b.length) {
    const x = a.codePointAt(left) ?? 0;
    const y = b.codePointAt(right) ?? 0;
    if (x !== y) return x - y;
    left += x > 0xffff ? 2 : 1;
    right += y > 0xffff ? 2 : 1;
  }
  return a.length - b.length;
}
export const sourceOid = (oid: string) => {
  if (!/^[a-f0-9]{40}$/.test(oid))
    throw sourceError('SOURCE_OBJECT', 'Artifacts source requires an exact Git SHA-1 object');
  return oid;
};
export function sourceRepository(env: Env, revision: SourceRevision): string {
  const [namespace, name, extra] = revision.repository.split('/');
  if (extra || namespace !== env.ARTIFACTS_NAMESPACE || !safeId(name))
    throw sourceError('SOURCE_SCOPE', 'Source revision is outside the approved namespace');
  sourceOid(revision.commit);
  sourceOid(revision.tree);
  return name;
}
export function sourceEntry(entry: ArtifactsTreeEntry): void {
  sourcePath(entry.name);
  if (entry.name.includes('/')) throw sourceError('SOURCE_PATH', 'Invalid Git tree child');
  sourceOid(entry.hash);
  const valid =
    (entry.type === 'tree' && ['40000', '040000'].includes(entry.mode)) ||
    (entry.type === 'blob' && entry.mode === '100644') ||
    (entry.type === 'exec' && entry.mode === '100755');
  if (!valid)
    throw sourceError(
      'SOURCE_OBJECT',
      'Source links, submodules, and inconsistent modes are unavailable',
    );
}

/** Prove the frozen commit/root/path link before any cached content read. */
export async function sourceLink(repo: ArtifactsRepo, revision: SourceRevision, path: string) {
  sourcePath(path);
  const commit = await repo.readCommit(sourceOid(revision.commit));
  if (!commit || commit.hash !== revision.commit || commit.treeHash !== revision.tree)
    throw sourceError('SOURCE_CHANGED', 'Frozen source commit or tree differs');
  let tree = revision.tree;
  const parts = path.split('/');
  for (let index = 0; index < parts.length; index++) {
    const entries = await repo.readTree(tree);
    if (!entries || entries.length > SOURCE_LIMITS.files)
      throw sourceError('SOURCE_OBJECT', 'Source tree is missing or exceeds limits');
    const matches = entries.filter((entry) => entry.name === parts[index]);
    if (matches.length !== 1)
      throw sourceError('SOURCE_OBJECT', 'Source path is missing or ambiguous');
    const entry = matches[0];
    sourceEntry(entry);
    if (index === parts.length - 1) return entry;
    if (entry.type !== 'tree')
      throw sourceError('SOURCE_PATH', 'Source path traverses a non-directory');
    tree = entry.hash;
  }
  throw sourceError('SOURCE_PATH', 'Source path is unavailable');
}
