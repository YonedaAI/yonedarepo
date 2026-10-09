import { safeId } from './http';
import type { Env, Json } from './types';
export async function source(env: Env, revision: Json, expectedTree?: string) {
  const [namespace, name, extra] = String(revision.repository).split('/');
  if (extra || namespace !== env.ARTIFACTS_NAMESPACE || !safeId(name))
    throw new Error('Revision is outside this namespace');
  using repo = await env.ARTIFACTS.get(name);
  const commit = await repo.readCommit(revision.commit);
  if (!commit) throw new Error('Captured commit is missing');
  if (expectedTree !== undefined && commit.treeHash !== expectedTree)
    throw new Error('Captured source tree differs from the frozen manifest');
  const files: Json = Object.create(null);
  let bytes = 0;
  async function walk(hash: string, prefix: string, depth: number) {
    if (depth > 20) throw new Error('Source nesting exceeds limit');
    const entries = await repo.readTree(hash);
    if (!entries) throw new Error('Source tree missing');
    for (const entry of entries) {
      if (
        !entry.name ||
        /[\\/\0:]/.test(entry.name) ||
        ['.', '..', '.git'].includes(entry.name.toLowerCase())
      )
        throw new Error('Unsafe source path');
      const path = prefix + entry.name;
      if (entry.type === 'tree') {
        await walk(entry.hash, `${path}/`, depth + 1);
        continue;
      }
      if (!['blob', 'exec'].includes(entry.type))
        throw new Error(
          'Only regular files are supported; symlinks and Git submodules need conversion',
        );
      const blob = await repo.readBlob(entry.hash);
      if (!blob) throw new Error('Source blob missing');
      bytes += blob.size;
      if (bytes > 8 * 1024 * 1024 || Object.keys(files).length >= 500)
        throw new Error('Source exceeds MVP limit');
      const data = new Uint8Array(await blob.arrayBuffer());
      try {
        const content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(data);
        files[path] = { content, executable: entry.type === 'exec' };
      } catch {
        // Chunk conversion avoids stack overflow for a large binary asset.
        let binary = '';
        for (let offset = 0; offset < data.length; offset += 8192)
          binary += String.fromCharCode(...data.subarray(offset, offset + 8192));
        files[path] = {
          content: btoa(binary),
          encoding: 'base64',
          executable: entry.type === 'exec',
        };
      }
    }
  }
  await walk(commit.treeHash, '', 0);
  return { files };
}
