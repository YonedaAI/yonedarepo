import { env } from 'cloudflare:workers';
import { reset } from 'cloudflare:test';
import { afterEach, expect, it } from 'vitest';
import { captureResult } from '../../cloudflare/worker/capture-result';
import { ledger } from '../../cloudflare/worker/storage';
import type { Env, Scope } from '../../cloudflare/worker/types';

afterEach(reset);
const base = 'a'.repeat(40), target = 'b'.repeat(40), head = 'c'.repeat(40);
const tree = (revision: string) => revision[0].repeat(40);
function fixture(parents: string[]) {
  const repository = {
    [Symbol.dispose]() {},
    async readCommit(commit: string) { return { treeHash: tree(commit), parents: commit === target ? parents : [] }; },
    async readTree(hash: string) { return [{ name: 'file.txt', type: 'blob', hash: (hash === tree(base) ? 'd' : 'e').repeat(40) }]; },
    async info() { return { defaultBranch: 'main' }; },
    async log() { return [{ hash: head }]; },
  };
  const bindings = { ...env, ARTIFACTS_NAMESPACE: 'yoneda-test', ARTIFACTS: { get: async () => repository } } as unknown as Env;
  const scope = { repo_id: 'capture-readback', fork: 'yoneda-test/fork', job: { id: 'capture-job', epoch: 3, kind: 'capture',
    payload: { base: { repository: 'yoneda-test/canonical', commit: base } } } } as unknown as Scope;
  const result = { id: 'candidate', tree: tree(target), revision: { repository: scope.fork, commit: target }, diff: 'recorded diff',
    paths: ['forged.txt'], file_provenance: [{ path: 'forged.txt', authority: 'agent' }], diff_digest: 'f'.repeat(64) };
  return { bindings, scope, result };
}

it('replaces every path, blob and diff pointer claim using independent tree/R2 readback', async () => {
  const { bindings, scope, result } = fixture([base]);
  const command = await captureResult(bindings, scope, result);
  expect(command).toMatchObject({ op: 'finish', job_id: 'capture-job', epoch: 3,
    result: { paths: ['file.txt'], file_provenance: [{ path: 'file.txt', change: 'modify', old_blob: 'd'.repeat(40), new_blob: 'e'.repeat(40) }] } });
  expect(command.result.diff_digest).not.toBe(result.diff_digest);
  expect(command.result.diff).toBeUndefined();
  expect(await bindings.OBJECTS.get(`sha256/${command.result.diff_digest}`)).not.toBeNull();
});

it('rejects an unapproved parent before binding capture evidence', async () => {
  const { bindings, scope, result } = fixture([head]);
  await expect(captureResult(bindings, scope, result)).rejects.toMatchObject({ code: 'INVALID_CAPTURE' });
  expect((await bindings.OBJECTS.list()).objects).toHaveLength(0);
});

it('resolver readback separates approved conflict edits from already merged clean changes', async () => {
  const { bindings, scope, result } = fixture([base]);
  await ledger(bindings, scope.repo_id, { op: 'init', id: scope.repo_id, name: 'Resolver readback', commit: base,
    remote: { namespace: 'yoneda-test', name: 'canonical' },
    policy: { version: 'v1', required_checks: ['retry'], suite: 'retry-contract-v1', environment: 'linux-rust-1.94-v1' } });
  scope.job.payload.capture_subtype = 'resolve_conflict';
  scope.job.payload.expected_head = base;
  scope.job.payload.expected_version = 0;
  scope.job.payload.merge_workspace_revision = { repository: scope.fork, commit: head };
  const command = await captureResult(bindings, scope, { ...result, resolver_delta_paths: ['forged.txt'] });
  expect(command.result.resolver_delta_paths).toEqual([]);
  expect(command.result.paths).toEqual(['file.txt']);
  expect(command.result.readback).toMatchObject({ candidate_commit: target, captured_paths: ['file.txt'], resolver_delta_paths: [], parents: [base] });
});

it('refresh readback binds both parents and independently observes canonical head/version', async () => {
  const { bindings, scope, result } = fixture([head, base]);
  await ledger(bindings, scope.repo_id, { op: 'init', id: scope.repo_id, name: 'Refresh readback', commit: head,
    remote: { namespace: 'yoneda-test', name: 'canonical' },
    policy: { version: 'v1', required_checks: ['retry'], suite: 'retry-contract-v1', environment: 'linux-rust-1.94-v1' } });
  scope.job.payload = { capture_subtype: 'refresh_candidate', expected_base: base, expected_head: head,
    expected_version: 0, candidate: { revision: { repository: 'yoneda-test/original', commit: base } } };
  const command = await captureResult(bindings, scope, { ...result, status: 'clean', merge_commit: target,
    readback: { observed_head: 'forged', version: 99 }, merge_tree: tree(target) });
  expect(command.op).toBe('conflict_refresh_complete');
  expect(command.result.readback).toMatchObject({ observed_head: head, version: 0, parents: [head, base] });
});
