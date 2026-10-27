import { cacheSourceBlob } from './source-cache';
import {
  type R2Content,
  SOURCE_LIMITS,
  type SourceBinding,
  type SourceContent,
  type SourceRead,
  type SourceRevision,
  sourceError,
} from './source-contract';
import { sourceLink, sourceRepo } from './source-path';
import type { Env } from './types';

export async function verifyTicketObject(env: Env, workspaceId: string, content: R2Content) {
  const expected = `source/v1/${workspaceId}/uploads/${content.ticket_id}/${content.sha256}`;
  if (
    content.key !== expected ||
    !/^[a-f0-9]{64}$/.test(content.sha256) ||
    !Number.isSafeInteger(content.size) ||
    content.size < 0 ||
    content.size > SOURCE_LIMITS.fileBytes
  )
    throw sourceError('SOURCE_SCOPE', 'Source ticket object differs from its native reservation');
  const head = await env.OBJECTS.head(expected);
  if (!head || head.size !== content.size || head.checksums.toJSON().sha256 !== content.sha256)
    throw sourceError('SOURCE_CHECKSUM', 'Source ticket bytes are not verified');
  return head;
}

/** Pointer supplied by native source_read or registered sealed capture, never client JSON. */
export async function sourceContentKey(
  env: Env,
  binding: Pick<SourceBinding, 'workspace_id' | 'inputs'>,
  content: SourceContent,
  expectedSize: number,
) {
  if (content.kind === 'r2') {
    const head = await verifyTicketObject(env, binding.workspace_id, content);
    if (head.size !== expectedSize)
      throw sourceError('SOURCE_CHANGED', 'Source pointer length differs');
    return { key: content.key, size: head.size, etag: head.etag, sha256: content.sha256 };
  }
  const revision = binding.inputs.find(
    (input) => input.repository === content.repository && input.commit === content.commit,
  );
  if (!revision) throw sourceError('SOURCE_SCOPE', 'Source pointer is outside the approved inputs');
  const repo = await sourceRepo(env, revision);
  const entry = await sourceLink(repo, revision, content.path);
  if (!['blob', 'exec'].includes(entry.type) || entry.hash !== content.blob)
    throw sourceError('SOURCE_SCOPE', 'Source object is not linked at its original frozen path');
  const cached = await cacheSourceBlob(env, repo, revision, content.blob);
  if (cached.size !== expectedSize)
    throw sourceError('SOURCE_CHANGED', 'Source cached length differs');
  return cached;
}

export async function sourceReadResponse(
  env: Env,
  binding: Pick<SourceBinding, 'workspace_id' | 'inputs'>,
  read: SourceRead,
) {
  if (
    read.workspace_id !== binding.workspace_id ||
    !Number.isSafeInteger(read.offset) ||
    read.offset < 0 ||
    !Number.isSafeInteger(read.length) ||
    read.length < 0 ||
    read.length > SOURCE_LIMITS.readBytes ||
    read.offset + read.length > read.file.size
  )
    throw sourceError('SOURCE_SCOPE', 'Source range differs from its authorized native read');
  const object = await sourceContentKey(env, binding, read.content, read.file.size);
  const body = read.length
    ? await env.OBJECTS.get(object.key, { range: { offset: read.offset, length: read.length } })
    : null;
  if (read.length && (!body || body.etag !== object.etag))
    throw sourceError('SOURCE_CHANGED', 'Source content changed before range read');
  const { content: _privatePointer, ...metadata } = read;
  const { content: _filePointer, ...file } = read.file;
  return new Response(body?.body ?? null, {
    status: read.length > 0 && (read.offset > 0 || read.length < read.file.size) ? 206 : 200,
    headers: {
      'content-type': 'application/octet-stream',
      'content-length': String(read.length),
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      'x-yoneda-source': encodeURIComponent(
        JSON.stringify({
          ...metadata,
          file: {
            ...file,
            blob_id: read.content.kind === 'git' ? read.content.blob : read.content.sha256,
          },
        }),
      ),
      'x-yoneda-file-version': String(read.file.file_version),
      'x-yoneda-workspace-version': String(read.workspace_version),
      'x-yoneda-offset': String(read.offset),
      'x-yoneda-source-size': String(read.file.size),
      'x-yoneda-source-mode': read.file.mode,
      'x-yoneda-source-sha256': object.sha256,
      'x-source-sha256': object.sha256,
      'content-range': read.length
        ? `bytes ${read.offset}-${read.offset + read.length - 1}/${read.file.size}`
        : `bytes */${read.file.size}`,
    },
  });
}

export async function immutableSourceFile(
  env: Env,
  revision: SourceRevision,
  path: string,
  offset: number,
  limit: number,
) {
  const repo = await sourceRepo(env, revision);
  const entry = await sourceLink(repo, revision, path);
  if (!['blob', 'exec'].includes(entry.type))
    throw sourceError('SOURCE_PATH', 'Only regular source files can be read');
  const object = await cacheSourceBlob(env, repo, revision, entry.hash);
  if (
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    offset > object.size ||
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > SOURCE_LIMITS.readBytes
  )
    throw sourceError('SOURCE_LIMIT', 'Invalid source read range');
  const workspaceId = `immutable:${revision.commit}`;
  return sourceReadResponse(
    env,
    { workspace_id: workspaceId, inputs: [revision] },
    {
      version: 1,
      workspace_id: workspaceId,
      workspace_version: 0,
      file: {
        path,
        kind: 'file',
        exists: true,
        file_version: 0,
        mode: entry.mode as '100644' | '100755',
        size: object.size,
        content: {
          kind: 'git',
          repository: revision.repository,
          commit: revision.commit,
          path,
          blob: entry.hash,
        },
      },
      content: {
        kind: 'git',
        repository: revision.repository,
        commit: revision.commit,
        path,
        blob: entry.hash,
      },
      offset,
      length: Math.min(limit, object.size - offset),
    },
  );
}
