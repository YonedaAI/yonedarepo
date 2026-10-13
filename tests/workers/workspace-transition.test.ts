import { reset } from 'cloudflare:test';
import { afterEach, expect, it } from 'vitest';
import { ledger } from '../../cloudflare/worker/storage';
import type { Env, Json } from '../../cloudflare/worker/types';
import { workspace } from '../../cloudflare/worker/workspace';
import { assertWorkspaceQuiescent } from '../../cloudflare/worker/workspace-transition';
import { bindings, signup } from './reviewer-fixture';

afterEach(reset);
const policy = { version: 'retry-v2', suite: 'retry-contract-v2', environment: 'rust-1.94.0-evaluator-v2', required_checks: ['build', 'behavior'] };
async function project(owner: string, id: string, status = 'ready') {
  await workspace(bindings, owner, { op: 'project_reserve', id, name: id, policy });
  if (status !== 'provisioning')
    await workspace(bindings, owner, { op: 'project_update', id, status });
  if (status === 'ready')
    await ledger(bindings, id, { op: 'init', id, name: id, workspace: owner,
      remote: { namespace: 'test', name: id }, commit: 'a'.repeat(40), policy });
}

it('accepts an empty workspace or terminal visible history without changing any state', async () => {
  const owner = 'transition_idle'; await signup(owner);
  await expect(assertWorkspaceQuiescent(bindings, owner)).resolves.toBeUndefined();
  await project(owner, 'idle-project');
  await ledger(bindings, 'idle-project', { op: 'start_run', id: 'old', intent: 'Old legacy run' });
  await ledger(bindings, 'idle-project', { op: 'cancel_run', run_id: 'old' });
  const before = await ledger(bindings, 'idle-project', { op: 'run_detail', run_id: 'old' });
  const inventory = await workspace(bindings, owner, { op: 'projects' });
  const receipt = await ledger(bindings, 'idle-project', { op: 'project_visibility_check', _workspace: owner });
  expect(receipt).toMatchObject({ quiescent: true, all_runs_hidden: false });
  await expect(assertWorkspaceQuiescent(bindings, owner)).resolves.toBeUndefined();
  expect(await ledger(bindings, 'idle-project', { op: 'run_detail', run_id: 'old' })).toEqual(before);
  expect(await workspace(bindings, owner, { op: 'projects' })).toEqual(inventory);
  expect((await workspace(bindings, owner, { op: 'workspace_spend_status' })).version).toBe(0);
});

it('rejects one active legacy run among otherwise idle ready projects without cancellation', async () => {
  const owner = 'transition_active'; await signup(owner);
  await project(owner, 'idle-first'); await project(owner, 'active-second');
  await ledger(bindings, 'active-second', { op: 'start_run', id: 'active', intent: 'Active legacy run' });
  const before = await ledger(bindings, 'active-second', { op: 'run_detail', run_id: 'active' });
  await expect(assertWorkspaceQuiescent(bindings, owner)).rejects.toMatchObject({ code: 'WORKSPACE_TRANSITION_BUSY' });
  expect(await ledger(bindings, 'active-second', { op: 'run_detail', run_id: 'active' })).toEqual(before);
  expect((await workspace(bindings, owner, { op: 'workspace_spend_status' })).version).toBe(0);
});

it.each(['provisioning', 'failed'])('fails closed on a %s project rather than ignoring non-ready inventory', async (status) => {
  const owner = `transition_${status}`; await signup(owner);
  await project(owner, `project-${status}`, status);
  await expect(assertWorkspaceQuiescent(bindings, owner)).rejects.toMatchObject({ code: 'WORKSPACE_TRANSITION_BUSY' });
});

it('fails closed on absent or foreign authoritative repository state', async () => {
  const owner = 'transition_missing'; await signup(owner);
  await workspace(bindings, owner, { op: 'project_reserve', id: 'missing', name: 'Missing', policy });
  await workspace(bindings, owner, { op: 'project_update', id: 'missing', status: 'ready' });
  await expect(assertWorkspaceQuiescent(bindings, owner)).rejects.toMatchObject({ code: 'WORKSPACE_TRANSITION_BUSY' });
  await ledger(bindings, 'missing', { op: 'init', id: 'missing', name: 'Foreign', workspace: 'someone_else',
    remote: { namespace: 'test', name: 'missing' }, commit: 'a'.repeat(40), policy });
  await expect(assertWorkspaceQuiescent(bindings, owner)).rejects.toMatchObject({ code: 'WORKSPACE_TRANSITION_BUSY' });
});

it('requires exact authoritative receipt identity and boolean quiescence on readback', async () => {
  const owner = 'transition_receipt'; await signup(owner); await project(owner, 'receipt');
  const original = bindings.REPOSITORIES;
  for (const change of [{ quiescent: 'true' }, { workspace: 'other' }, { repo_id: 'other' }]) {
    const scoped = { ...bindings, REPOSITORIES: {
      idFromName: (name: string) => original.idFromName(name),
      get: (id: DurableObjectId) => ({ fetch: async (url: string, init: RequestInit) => {
        const result = await original.get(id).fetch(url, init);
        const value = await result.json<Json>();
        return Response.json(JSON.parse(String(init.body)).op === 'project_visibility_check' ? { ...value, ...change } : value);
      } }),
    } } as unknown as Env;
    await expect(assertWorkspaceQuiescent(scoped, owner)).rejects.toMatchObject({ code: 'WORKSPACE_TRANSITION_BUSY' });
  }
});

it('includes hidden projects and rejects work started through their retained direct authority', async () => {
  const owner = 'transition_hidden'; await signup(owner); await project(owner, 'hidden-project');
  const receipt = await ledger(bindings, 'hidden-project', { op: 'project_visibility_check', _workspace: owner });
  await workspace(bindings, owner, { op: 'project_set_visibility', id: 'hidden-project', _workspace: owner,
    hidden: true, expected_hidden: false, reason: 'Synthetic hidden idle project', _visibility: receipt });
  expect((await workspace(bindings, owner, { op: 'projects' })).projects).toEqual([]);
  await expect(assertWorkspaceQuiescent(bindings, owner)).resolves.toBeUndefined();
  await ledger(bindings, 'hidden-project', { op: 'start_run', id: 'hidden-active', intent: 'Retained direct legacy authority' });
  await expect(assertWorkspaceQuiescent(bindings, owner)).rejects.toMatchObject({ code: 'WORKSPACE_TRANSITION_BUSY' });
});
