import { sourceAuthority } from './source-authority';
import {
  type SourceActor,
  type SourceBinding,
  type SourceFile,
  sourceError,
} from './source-contract';
import { sourceContentKey } from './source-storage';
import { ledger } from './storage';
import type { Env, Json, Scope } from './types';

/** Bounds on what one resume replays into the new attempt's own workspace. */
export const RESUME_LIMITS = { files: 400, bytes: 8 * 1024 * 1024 };

type Staged = { path: string; after: SourceFile | null };
type StagedPage = { items: Staged[]; has_more: boolean; next_cursor: string | null };

export type ResumeFile = { path: string; mode: '100644' | '100755'; content_base64: string };
export type ResumeManifest = {
  version: 1;
  epoch: number | null;
  reason: string | null;
  files: ResumeFile[];
  deleted: string[];
  skipped: string[];
};

function base64(bytes: Uint8Array) {
  let binary = '';
  for (let index = 0; index < bytes.length; index += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  return btoa(binary);
}

/**
 * Return the interrupted attempt's staged files to the supervisor, which writes them through
 * its own scoped mount so ordinary write authorization and versioning apply. The checkpoint
 * identity comes from the claimed job record and a ledger-signed read-only grant, never from
 * the request body or model arguments.
 */
export async function sourceResume(env: Env, scope: Scope): Promise<ResumeManifest> {
  const empty: ResumeManifest = {
    version: 1,
    epoch: null,
    reason: null,
    files: [],
    deleted: [],
    skipped: [],
  };
  const recorded = scope.job.resume as Json | null | undefined;
  if (!recorded?.workspace_id || scope.job.kind !== 'agent') return empty;
  const granted = (await ledger(env, scope.repo_id, {
    op: 'source_resume_grant',
    job_id: scope.job.id,
    epoch: scope.job.epoch,
  })) as {
    workspace_id: string;
    epoch: number;
    reason: string;
    binding: SourceBinding;
    actor_grant: SourceActor;
  };
  if (
    granted.workspace_id !== recorded.workspace_id ||
    granted.binding?.workspace_id !== recorded.workspace_id ||
    granted.binding.job_id !== scope.job.id ||
    granted.actor_grant?.claims.access !== 'read_only' ||
    granted.actor_grant.claims.purpose !== 'supervisor' ||
    granted.actor_grant.claims.workspace_id !== recorded.workspace_id
  )
    throw sourceError('SOURCE_SCOPE', 'Resume grant differs from the recorded checkpoint');
  const manifest: ResumeManifest = { ...empty, epoch: granted.epoch, reason: granted.reason };
  let bytes = 0;
  let after = '';
  for (;;) {
    const page = await sourceAuthority<StagedPage>(env, granted.workspace_id, {
      op: 'source_staged_changes',
      after,
      limit: 200,
      _actor: granted.actor_grant,
    });
    for (const item of page.items) {
      if (item.after === null) {
        manifest.deleted.push(item.path);
        continue;
      }
      const file = item.after;
      if (
        manifest.files.length >= RESUME_LIMITS.files ||
        bytes + file.size > RESUME_LIMITS.bytes ||
        file.path !== item.path
      ) {
        manifest.skipped.push(item.path);
        continue;
      }
      const object = await sourceContentKey(env, granted.binding, file.content, file.size);
      const body = await env.OBJECTS.get(object.key);
      if (!body || body.etag !== object.etag)
        throw sourceError('SOURCE_CHANGED', 'Resume content changed before it was read');
      const content = new Uint8Array(await body.arrayBuffer());
      if (content.byteLength !== file.size)
        throw sourceError('SOURCE_CHANGED', 'Resume content length differs from its staged file');
      bytes += content.byteLength;
      manifest.files.push({ path: file.path, mode: file.mode, content_base64: base64(content) });
    }
    if (!page.has_more || !page.next_cursor) break;
    after = page.next_cursor;
  }
  return manifest;
}
