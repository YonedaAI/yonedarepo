// Capture readback against the real platform repository: every path, blob and parent comes
// from the platform's own objects and the attempt's assigned candidate branch.
import { env } from 'cloudflare:workers';
import { reset } from 'cloudflare:test';
import { afterEach, expect, it } from 'vitest';
import { captureResult } from '../../cloudflare/worker/capture-result';
import { ledger, sha } from '../../cloudflare/worker/storage';
import type { Env, Json, Scope } from '../../cloudflare/worker/types';
import { gitSnapshot, platformCommit, platformProject } from './platform-fixture';
import { approvedLedger, finishSealed } from './source-kit';

afterEach(reset);
const bindings = env as unknown as Env;
const project = 'capture-readback';
const repository = `platform/${project}`;
const branch = 'agents/capture-0123456789abcdef0123456789abcdef';
const blob = async (text: string) => [...(await gitSnapshot({ f: text })).blobs.keys()][0];

async function fixture(files: Record<string, string> = { 'file.txt': 'target\n' }, onto?: string) {
  const { base, platform } = await platformProject(bindings, 'capture_owner', project, { 'file.txt': 'base\n' });
  // A real sealed attempt: its capture job carries the registered seal the readback checks.
  await approvedLedger(bindings, project)({ op: 'start_run', id: 'readback', intent: 'Capture readback',
    agents: [{ provider: 'codex', model: 'gpt-5.6-luna', strategy: 'Readback fixture' }] });
  const agent = await ledger(bindings, project, { op: 'claim', job_id: 'job:readback:agent-1' });
  const registration = await finishSealed(bindings, project, agent);
  const capture = await ledger(bindings, project, { op: 'claim', job_id: 'capture:readback:agent-1' });
  const target = await platformCommit(platform, onto ?? base.commit, files);
  await platform.call('POST', '/branches', { ref: branch, commit: target.commit, expected: null });
  const scope = { repo_id: project, job: { ...capture, source_capture_ref: { branch } }, supervisor: 'fixture',
    model_calls: 0, created_at: Date.now() } as Scope;
  const result: Json = { id: 'candidate', tree: target.tree, revision: { repository, commit: target.commit },
    diff: 'recorded diff', paths: ['forged.txt'], file_provenance: [{ path: 'forged.txt', authority: 'agent' }],
    diff_digest: 'f'.repeat(64), parents: registration.binding.parents,
    source_changeset_digest: registration.changeset_digest, source_manifest_digest: registration.changeset_digest };
  return { base, platform, target, scope, result, capture };
}

it('replaces every path, blob and diff pointer claim using independent platform/R2 readback', async () => {
  const { scope, result, capture } = await fixture();
  const command = await captureResult(bindings, scope, result);
  expect(command).toMatchObject({ op: 'finish', job_id: capture.id, epoch: capture.epoch,
    result: { paths: ['file.txt'], file_provenance: [{ path: 'file.txt', change: 'modify',
      old_blob: await blob('base\n'), new_blob: await blob('target\n') }] } });
  expect(command.result.diff_digest).not.toBe(result.diff_digest);
  expect(command.result.diff).toBeUndefined();
  expect(await bindings.OBJECTS.get(`sha256/${command.result.diff_digest}`)).not.toBeNull();
});

it('rejects an unapproved parent, a foreign repository and a commit off its assigned branch', async () => {
  const seeded = await fixture();
  const other = await platformCommit(seeded.platform, seeded.base.commit, { 'other.txt': 'x\n' });
  // A capture whose parent is not the frozen base, even on the assigned branch.
  const stray = await platformCommit(seeded.platform, other.commit, { 'file.txt': 'stray\n' });
  await seeded.platform.call('POST', '/branches', { ref: branch, commit: stray.commit, expected: seeded.target.commit });
  const strayResult = { ...seeded.result, tree: stray.tree, revision: { repository, commit: stray.commit } };
  await expect(captureResult(bindings, seeded.scope, strayResult)).rejects.toMatchObject({ code: 'INVALID_CAPTURE' });
  // The base-parented commit is valid, but no longer the head of the assigned branch.
  await expect(captureResult(bindings, seeded.scope, seeded.result)).rejects.toMatchObject({ code: 'INVALID_CAPTURE' });
  const foreign = { ...seeded.result, revision: { repository: 'platform/other-project', commit: seeded.target.commit } };
  await expect(captureResult(bindings, seeded.scope, foreign)).rejects.toMatchObject({ code: 'FORBIDDEN' });
  // No diff was stored for any refused capture.
  expect(await bindings.OBJECTS.get(`sha256/${await sha('recorded diff')}`)).toBeNull();
});

it('resolver readback separates approved conflict edits from already merged clean changes', async () => {
  const f = await fixture({ 'file.txt': 'target\n', 'resolved.txt': 'resolved\n' });
  // The merge workspace already carries the clean change to file.txt.
  const workspace = await platformCommit(f.platform, f.base.commit, { 'file.txt': 'target\n' });
  Object.assign(f.scope.job.payload, { source_resolution: true, expected_head: f.base.commit, expected_version: 0,
    merge_workspace_revision: { repository, commit: workspace.commit } });
  const command = await captureResult(bindings, f.scope, { ...f.result, resolver_delta_paths: ['forged.txt'] });
  expect(command.result.resolver_delta_paths).toEqual(['resolved.txt']);
  expect(command.result.paths).toEqual(['file.txt', 'resolved.txt']);
  expect(command.result.readback).toMatchObject({ observed_head: f.base.commit, version: 0,
    candidate_commit: f.target.commit, captured_paths: ['file.txt', 'resolved.txt'],
    resolver_delta_paths: ['resolved.txt'], parents: [f.base.commit] });
  Object.assign(f.scope.job.payload, { merge_workspace_revision: { repository: 'platform/foreign', commit: workspace.commit } });
  await expect(captureResult(bindings, f.scope, f.result)).rejects.toMatchObject({ code: 'INVALID_CAPTURE' });
});
