import { expect, it, vi } from 'vitest';
import { freezeSourceApproval } from '../../cloudflare/worker/api-source-approval';
import { ownerCommandInput } from '../../cloudflare/worker/repository-command';
import type { Env } from '../../cloudflare/worker/types';

const repository = { capabilities: { source_api: 1 }, remote: { namespace: 'test', name: 'repo-fresh' }, published_commit: 'a'.repeat(40) };
const readable = () => vi.fn(async () => ({ readCommit: async () => ({ hash: 'a'.repeat(40), treeHash: 'b'.repeat(40) }), [Symbol.dispose]() {} }));

it.each([
  ['no source binding', {}, repository],
  ['a ledger without source capability', { SOURCES: {} }, { ...repository, capabilities: {} }],
])('refuses to start without lazy source (%s) and never opens source', async (_, bindings, repo) => {
  const get = vi.fn(async () => { throw new Error('Source must never be opened'); });
  const env = { ...bindings, ARTIFACTS_NAMESPACE: 'test', ARTIFACTS: { get } } as unknown as Env;
  const input = { workspace_transport: 'json-v1', _source_transport_approved: true, _source_base: { forged: true } };
  await expect(freezeSourceApproval(env, 'owner', 'repo-fresh', input, repo)).rejects.toMatchObject({ code: 'LEDGER_UPDATING' });
  expect(input).toEqual({});
  expect(get).not.toHaveBeenCalled();
});

it('freezes only the SDK readback of the exact published source, replacing forged fields', async () => {
  const get = readable();
  const env = { SOURCES: {}, ARTIFACTS_NAMESPACE: 'test', ARTIFACTS: { get } } as unknown as Env;
  const input = { workspace_transport: 'json-v1', _source_transport_approved: false, _source_base: { forged: true } };
  await freezeSourceApproval(env, 'owner', 'repo-fresh', input, repository);
  expect(input).toEqual({ workspace_transport: 'api-source-v1', _source_transport_approved: true,
    _source_base: { repository: 'test/repo-fresh', commit: 'a'.repeat(40), tree: 'b'.repeat(40) } });
  expect(get).toHaveBeenCalledWith('repo-fresh');
});

it('rejects a source identity outside this namespace before any read', async () => {
  const get = readable();
  const env = { SOURCES: {}, ARTIFACTS_NAMESPACE: 'test', ARTIFACTS: { get } } as unknown as Env;
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
