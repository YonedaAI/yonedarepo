// Whole-commit reads of a project's source (small snapshots and setup validation), through
// the platform's public API.
import { openSource, type SourceRepo } from './source-objects';
import type { Env, Json } from './types';
export async function source(
  env: Env,
  revision: Json,
  expectedTree?: string,
  limits = { bytes: 8 * 1024 * 1024, files: 500 },
) {
  const repo = await openSource(env, String(revision.repository));
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
      if (blob.size > 32000000 || bytes > limits.bytes || Object.keys(files).length >= limits.files)
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

// Validate a project's head shape without reading file contents: regular files and safe
// paths only, within the source file limit. Byte limits apply when lazy source reads them.
export async function validateSourceMetadata(repo: SourceRepo, commitId: string) {
  const commit = await repo.readCommit(commitId);
  if (!commit) throw new Error('Captured commit is missing');
  let count = 0;
  async function walk(hash: string, prefix: string, depth: number): Promise<void> {
    if (depth > 512) throw new Error('Source nesting exceeds limit');
    const entries = await repo.readTree(hash);
    if (!entries) throw new Error('Source tree missing');
    for (const entry of entries) {
      if (
        !entry.name ||
        /[\\/\0:]/.test(entry.name) ||
        ['.', '..', '.git'].includes(entry.name.toLowerCase())
      )
        throw new Error('Unsafe source path');
      const path = `${prefix}${entry.name}`;
      if (path.length > 512) throw new Error('Unsafe source path');
      if (entry.type === 'tree') {
        await walk(entry.hash, `${path}/`, depth + 1);
        continue;
      }
      if (!['blob', 'exec'].includes(entry.type))
        throw new Error(
          'Only regular files are supported; symlinks and Git submodules need conversion',
        );
      if (++count > 10_000) throw new Error('Source exceeds workspace limits');
    }
  }
  await walk(commit.treeHash, '', 0);
  if (!count) throw new Error('Source workspace is empty');
  return { commit: commitId, tree: commit.treeHash, files: count };
}
