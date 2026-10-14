// HTTP adapter ordering/whitelist tests. Native transactions are tested separately.
import { afterEach, expect, it, vi } from 'vitest';
import { guidedRoute, guidedSessionId } from '../../cloudflare/worker/guided-route';
import { guidedPolicy } from '../../cloudflare/worker/guided-profile';
import { sourceFingerprint } from '../../cloudflare/worker/source-crypto';
import type { Env, Json } from '../../cloudflare/worker/types';

const { call, prepare } = vi.hoisted(() => ({ call: vi.fn(), prepare: vi.fn() }));
vi.mock('../../cloudflare/worker/storage', async importOriginal => ({
  ...await importOriginal<typeof import('../../cloudflare/worker/storage')>(), ledger: call,
}));
vi.mock('../../cloudflare/worker/guided-preparation', () => ({ prepareGuidedRuns: prepare }));
afterEach(() => { call.mockReset(); prepare.mockReset(); });
// Starting the guided demo spends operator-funded agents and needs a reviewer account.
const owner = { role: 'user' as const, workspace: 'ordinary', reviewer: true };
const env = {} as Env;

async function fixture(step = 'build') {
  const policy = guidedPolicy('d'.repeat(64));
  const repository = { policy, capabilities: { guided_runs: 1 }, guided_project: { profile_id: 'task-board-v1', version: 1,
    policy_digest: await sourceFingerprint(policy), test_bundle_digest: 'd'.repeat(64),
    starter: { repository: 'test/starter', branch: 'main', commit: 'a'.repeat(40), tree: 'b'.repeat(40) } } };
  const body = { request_id: 'lost-ack', session_id: await guidedSessionId('fresh'), profile_id: 'task-board-v1',
    step_id: step, expected_commit: 'a'.repeat(40), expected_version: 0 };
  const request = (input = body) => new Request('https://local/api/repos/fresh/start_guided_step',
    { method: 'POST', body: JSON.stringify(input) });
  return { repository, body, request };
}

it('lost acknowledgment replays the original CAS before any new provider/spend/working-head approval', async () => {
  const f = await fixture();
  const receipt = { session_id: f.body.session_id, working_revision: { commit: 'c'.repeat(40) },
    working_version: 4, steps: [{ id: 'build', run_ids: ['original-run'], status: 'complete' }] };
  call.mockResolvedValueOnce(f.repository).mockResolvedValueOnce(receipt);
  prepare.mockRejectedValue(new Error('Saved connections have rotated and wallet is exhausted'));
  const result = await guidedRoute(f.request(), env, owner, 'fresh', 'start_guided_step');
  expect(await result?.json()).toMatchObject(receipt);
  expect(call.mock.calls.map(args => args[2].op)).toEqual(['repository_status', 'start_guided_step']);
  expect(call.mock.calls[1][2]).toMatchObject({ ...f.body, _guided_runs: [], _workspace: 'ordinary' });
  expect(prepare).not.toHaveBeenCalled();
});

it('an older ledger cannot expose a session or receive a start until the guided capability is adopted', async () => {
  const f = await fixture();
  call.mockResolvedValueOnce({ ...f.repository, capabilities: {} });
  await expect(guidedRoute(f.request(), env, owner, 'fresh', 'start_guided_step'))
    .rejects.toMatchObject({ code: 'LEDGER_UPDATING' });
  expect(call).toHaveBeenCalledTimes(1);
  expect(prepare).not.toHaveBeenCalled();
});

it('fresh concurrent start prepares both approvals only after Native requests the exact trusted run count', async () => {
  const f = await fixture('concurrent');
  const session = { session_id: f.body.session_id, steps: [], working_version: 0 };
  const runs = [{ id: 'filter' }, { id: 'sort' }];
  call.mockResolvedValueOnce(f.repository)
    .mockRejectedValueOnce(Object.assign(new Error('Guided step needs its exact trusted run count'), { code: 'INVALID_INPUT' }))
    .mockResolvedValueOnce(session).mockResolvedValueOnce({ steps: [{ id: 'concurrent', run_ids: ['filter', 'sort'] }] });
  prepare.mockResolvedValueOnce(runs);
  await guidedRoute(f.request(), env, owner, 'fresh', 'start_guided_step');
  expect(prepare).toHaveBeenCalledExactlyOnceWith(env, owner, 'fresh', session, 'concurrent', f.body.expected_commit, 0);
  expect(call.mock.calls[3][2]).toMatchObject({ ...f.body, _guided_runs: runs });
});

it('Native stale/failure errors never trigger a new approval', async () => {
  const f = await fixture();
  call.mockResolvedValueOnce(f.repository).mockRejectedValueOnce(Object.assign(new Error('Guided checked head changed'), { code: 'HEAD_MOVED' }));
  await expect(guidedRoute(f.request(), env, owner, 'fresh', 'start_guided_step')).rejects.toMatchObject({ code: 'HEAD_MOVED' });
  expect(prepare).not.toHaveBeenCalled();
});

it('session GET is read-only and browser authority fields cannot reach a start', async () => {
  const f = await fixture();
  call.mockResolvedValueOnce(f.repository).mockResolvedValueOnce({ steps: [] });
  await guidedRoute(new Request('https://local/api/repos/fresh/guided_session'), env, owner, 'fresh', 'guided_session');
  expect(call.mock.calls.map(args => args[2].op)).toEqual(['repository_status', 'guided_session']);
  call.mockReset().mockResolvedValueOnce(f.repository);
  await expect(guidedRoute(f.request({ ...f.body, _guided_runs: [] } as typeof f.body), env, owner, 'fresh', 'start_guided_step'))
    .rejects.toMatchObject({ code: 'INVALID_INPUT' });
  expect(call).toHaveBeenCalledTimes(1);
  expect(prepare).not.toHaveBeenCalled();
});
