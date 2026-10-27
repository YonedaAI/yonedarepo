import { env as workerEnv } from 'cloudflare:workers';
import { reset } from 'cloudflare:test';
import { afterEach, expect, it, vi } from 'vitest';
import { freezeSourceApproval } from '../../cloudflare/worker/api-source-approval';
import { ownerCommandInput } from '../../cloudflare/worker/repository-command';
import type { Env } from '../../cloudflare/worker/types';
import { syntheticPlatform } from './platform-fixture';

afterEach(reset);
const repository = { capabilities: { source_api: 1 }, remote: { namespace: 'platform', name: 'repo-fresh' }, published_commit: 'a'.repeat(40) };
const readCommit = () => vi.fn(async (hash: string) => ({ hash, treeHash: 'b'.repeat(40) }));

it.each([
  ['no source binding', {}, repository],
  ['a ledger without source capability', { SOURCES: {} }, { ...repository, capabilities: {} }],
])('refuses to start without lazy source (%s) and never opens source', async (_, bindings, repo) => {
  const get = vi.fn(async () => { throw new Error('Source must never be opened'); });
  const env = { ...bindings, PLATFORM: { fetch: get } } as unknown as Env;
  const input = { workspace_transport: 'json-v1', _source_transport_approved: true, _source_base: { forged: true } };
  await expect(freezeSourceApproval(env, 'owner', 'repo-fresh', input, repo)).rejects.toMatchObject({ code: 'LEDGER_UPDATING' });
  expect(input).toEqual({});
  expect(get).not.toHaveBeenCalled();
});

it('freezes only the SDK readback of the exact published source, replacing forged fields', async () => {
  const read = readCommit();
  const env = await syntheticPlatform(workerEnv as unknown as Env, { 'repo-fresh': { readCommit: read } });
  const input = { workspace_transport: 'json-v1', _source_transport_approved: false, _source_base: { forged: true } };
  await freezeSourceApproval(env, 'owner', 'repo-fresh', input, repository);
  expect(input).toEqual({ workspace_transport: 'api-source-v1', _source_transport_approved: true,
    _source_base: { repository: 'platform/repo-fresh', commit: 'a'.repeat(40), tree: 'b'.repeat(40) } });
  expect(read).toHaveBeenCalledWith('a'.repeat(40));
});

it('takes a sandbox compare run only from a ledger that runs one sandbox per agent', async () => {
  const get = vi.fn(async () => { throw new Error('Source must never be opened'); });
  const env = { SOURCES: {}, AGENT_SANDBOX: {}, PLATFORM: { fetch: get } } as unknown as Env;
  const v1 = { ...repository, capabilities: { source_api: 1, sandbox_cli: 1 } };
  const two = [{ connection: 'glm', role: 'builder' }, { connection: 'mimo', role: 'builder' }];
  const input = { runtime: 'sandbox-cli-v1', adaptive_team: { version: 1, requested_agents: two } };
  await expect(freezeSourceApproval(env, 'owner', 'repo-fresh', input, v1)).rejects.toMatchObject({ code: 'LEDGER_UPDATING' });
  expect(get).not.toHaveBeenCalled();
  const read = readCommit();
  const platform = await syntheticPlatform(workerEnv as unknown as Env, { 'repo-fresh': { readCommit: read } });
  const sandboxEnv = { ...platform, AGENT_SANDBOX: {} } as unknown as Env;
  const one = { runtime: 'sandbox-cli-v1', agents: [{ provider: 'zai' }] };
  await freezeSourceApproval(sandboxEnv, 'owner', 'repo-fresh', one, v1);
  expect(one).toMatchObject({ workspace_transport: 'sandbox-cli-v1' });
  const v2 = { ...repository, capabilities: { source_api: 1, sandbox_cli: 2 } };
  const compare = { runtime: 'sandbox-cli-v1', adaptive_team: { version: 1, requested_agents: two } };
  await freezeSourceApproval(sandboxEnv, 'owner', 'repo-fresh', compare, v2);
  expect(compare).toMatchObject({ workspace_transport: 'sandbox-cli-v1', _source_transport_approved: true });
});

it('starts a sandbox run without lazy-source workspaces: the sandbox clones the platform', async () => {
  const read = readCommit();
  const platform = await syntheticPlatform(workerEnv as unknown as Env, { 'repo-fresh': { readCommit: read } });
  const env = { ...platform, SOURCES: undefined, AGENT_SANDBOX: {} } as unknown as Env;
  const ledger = { ...repository, capabilities: { sandbox_cli: 2 } };
  const input = { runtime: 'sandbox-cli-v1', agents: [{ provider: 'zai' }] };
  await freezeSourceApproval(env, 'owner', 'repo-fresh', input, ledger);
  expect(input).toMatchObject({ workspace_transport: 'sandbox-cli-v1', _source_transport_approved: true });
  // A lazy-source run still needs them.
  await expect(freezeSourceApproval(env, 'owner', 'repo-fresh', {}, ledger)).rejects.toMatchObject({ code: 'LEDGER_UPDATING' });
});

it('rejects a source identity outside this namespace before any read', async () => {
  const get = vi.fn(async () => { throw new Error('Source must never be opened'); });
  const env = { SOURCES: {}, PLATFORM: { fetch: get } } as unknown as Env;
  const foreign = { ...repository, remote: { namespace: 'other', name: 'repo-fresh' } };
  await expect(freezeSourceApproval(env, 'owner', 'repo-fresh', {}, foreign)).rejects.toMatchObject({ code: 'INVALID_CAPTURE' });
  expect(get).not.toHaveBeenCalled();
});

it('strips guided authority from ordinary browser starts including future private markers', async () => {
  const input = await ownerCommandInput(new Request('https://yoneda/api/repos/repo/start_run', { method: 'POST', body: JSON.stringify({
    id: 'ordinary', intent: 'Normal account work', guided: { session_id: 'foreign' }, guided_session: { forged: true },
    guided_profile_id: 'task-board-v1', _guided_runs: [{ id: 'paid-forged' }], _guided_authority: true,
  }) }), 'start_run');
  expect(input).toEqual({ id: 'ordinary', intent: 'Normal account work' });
});
