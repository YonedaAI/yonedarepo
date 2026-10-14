import { expect, it, vi } from 'vitest';
import { freezeSourceApproval } from '../../cloudflare/worker/api-source-approval';
import { ownerCommandInput } from '../../cloudflare/worker/repository-command';
import type { Env } from '../../cloudflare/worker/types';
import { guidedPolicy } from '../../cloudflare/worker/guided-profile';
import { sourceFingerprint } from '../../cloudflare/worker/source-crypto';

it.each([undefined, '', 'repo-other', 'repo-fresh-extra', 'prefix-repo-fresh'])('keeps unlisted projects Git-native with no source I/O (%s)', async list => {
  const get = vi.fn(async () => { throw new Error('Unlisted source must never be opened'); });
  const env = { SOURCE_TRANSPORT: 'api-source-v1', SOURCE_TRANSPORT_REPOS: list, ARTIFACTS: { get } } as unknown as Env;
  const input = { workspace_transport: 'api-source-v1', _source_transport_approved: true, _source_base: { forged: true } };
  await freezeSourceApproval(env, { role: 'user', workspace: 'owner' }, 'repo-fresh', input, {});
  expect(input).toEqual({ workspace_transport: 'git-native-v1' });
  expect(get).not.toHaveBeenCalled();
});

it('requires both activation and an exact configured repository, then freezes only SDK readback', async () => {
  const get = vi.fn(async () => ({ readCommit: async () => ({ hash: 'a'.repeat(40), treeHash: 'b'.repeat(40) }), [Symbol.dispose]() {} }));
  const env = { SOURCE_TRANSPORT_REPOS: ' repo-other,repo-fresh ', SOURCES: {}, ARTIFACTS_NAMESPACE: 'test', ARTIFACTS: { get } } as unknown as Env;
  const principal = { role: 'user', workspace: 'owner' } as const;
  const repository = { capabilities: { source_api: 1 }, remote: { namespace: 'test', name: 'repo-fresh' }, published_commit: 'a'.repeat(40) };
  const off = {};
  await freezeSourceApproval(env, principal, 'repo-fresh', off, repository);
  expect(off).toEqual({ workspace_transport: 'git-native-v1' });
  expect(get).not.toHaveBeenCalled();
  env.SOURCE_TRANSPORT = 'api-source-v1';
  const on = {};
  await freezeSourceApproval(env, principal, 'repo-fresh', on, repository);
  expect(on).toEqual({ workspace_transport: 'api-source-v1', _source_transport_approved: true,
    _source_base: { repository: 'test/repo-fresh', commit: 'a'.repeat(40), tree: 'b'.repeat(40) } });
});

it('strips guided authority from ordinary browser starts including future private markers', async () => {
  const input = await ownerCommandInput(new Request('https://yoneda/api/repos/repo/start_run', { method: 'POST', body: JSON.stringify({
    id: 'ordinary', intent: 'Normal account work', guided: { session_id: 'foreign' }, guided_session: { forged: true },
    guided_profile_id: 'task-board-v1', _guided_runs: [{ id: 'paid-forged' }], _guided_authority: true,
  }) }), 'start_run');
  expect(input).toEqual({ id: 'ordinary', intent: 'Normal account work' });
});

it('guided activation requires explicit operator opt-in and the immutable policy matching the recorded profile', async () => {
  const policy = guidedPolicy('d'.repeat(64));
  const repository = { policy, guided_project: { profile_id: 'task-board-v1', version: 1,
    policy_digest: await sourceFingerprint(policy), test_bundle_digest: 'd'.repeat(64),
    starter: { commit: 'a'.repeat(40), tree: 'b'.repeat(40) } },
    capabilities: { source_api: 1 }, remote: { namespace: 'test', name: 'repo-fresh' }, published_commit: 'a'.repeat(40) };
  const get = vi.fn(async () => ({ readCommit: async () => ({ hash: 'a'.repeat(40), treeHash: 'b'.repeat(40) }), [Symbol.dispose]() {} }));
  const env = { SOURCE_TRANSPORT: 'api-source-v1', SOURCE_GUIDED_ENABLED: 'true', SOURCES: {},
    ARTIFACTS_NAMESPACE: 'test', ARTIFACTS: { get } } as unknown as Env;
  const off = {};
  await freezeSourceApproval({ ...env, SOURCE_GUIDED_ENABLED: undefined } as Env, { role: 'user', workspace: 'owner' }, 'repo-fresh', off, repository);
  expect(off).toEqual({ workspace_transport: 'git-native-v1' });
  expect(get).not.toHaveBeenCalled();
  const changed = {};
  await freezeSourceApproval(env, { role: 'user', workspace: 'owner' }, 'repo-fresh', changed, { ...repository, policy: { ...policy, version: 'changed' } });
  expect(changed).toEqual({ workspace_transport: 'git-native-v1' });
  expect(get).not.toHaveBeenCalled();
  const on = {};
  await freezeSourceApproval(env, { role: 'user', workspace: 'owner' }, 'repo-fresh', on, repository);
  expect(on).toMatchObject({ workspace_transport: 'api-source-v1', _source_transport_approved: true });
});
