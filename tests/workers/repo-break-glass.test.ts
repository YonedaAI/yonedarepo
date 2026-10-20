// Break-glass recovery end to end in workerd with automation down: no check runners bound,
// a platform queue that refuses every send, and the R2 object store. Only the owner's
// personal session gets in; tokens and MCP never reach it.
import { expect, it } from 'vitest';
import { platformFetch } from '../../cloudflare/worker/platform-routes';
import type { Env } from '../../cloudflare/worker/types';
import { api, author, file, queued, scoped, signup, usePlatformFixture } from './repo-fixture';

usePlatformFixture();

const healthy = { ...scoped, PLATFORM_OBJECT_STORE: 'r2', ARTIFACTS: undefined } as unknown as Env;
const refuse = async () => {
  throw new Error('Queue unavailable');
};
const down = {
  ...healthy,
  CHECK_RUNNERS: undefined,
  PLATFORM_QUEUE: { send: refuse, sendBatch: refuse },
} as unknown as Env;
const REFUSAL = 'Break-glass recovery is only for a signed-in human owner';

it('lets only the human owner land, revert and pause while checks and queues are down', async () => {
  const owner = { cookie: await signup('glass') };
  const policy = { required_checks: ['unit'], approvals: 1, runners: { unit: { command: ['true'], timeout_seconds: 30 } } };
  const created = await api('/repos', owner, { body: { name: 'bg', policy, files: [file('a.txt', 'one\n')], author } }, healthy);
  expect(created.status).toBe(200);
  const repo = `/repos/${created.body.id}`;
  const root = created.body.commit as string;
  const mint = async (name: string, scopes: string[]) =>
    ({ token: (await api(`${repo}/tokens`, owner, { body: { name, scopes } }, healthy)).body.token as string });
  const agent = await mint('agent', ['read', 'write', 'check', 'review', 'land']);
  const ci = await mint('ci', ['read', 'check']);
  const made = await api(`${repo}/commits`, agent, { body: { ref: 'main', changes: [file('a.txt', 'two\n')], message: 'two', author } }, healthy);
  const sha = made.body.commit as string;
  expect(queued.filter((m) => m.kind === 'platform_check')).toHaveLength(2);

  // From here on the check runner never runs and the queue is gone.
  const glass = (auth: { cookie?: string; token?: string }, body: unknown) => api(`${repo}/break-glass`, auth, { body }, down);
  const land = { action: 'land', ref: 'main', commit: sha, expected_old: root, reason: 'check runner is down' };
  for (const caller of [agent, ci]) {
    for (const action of ['land', 'revert', 'release_land_lease', 'pause_automation', 'resume_automation']) {
      const refused = await glass(caller, { ...land, action, expected_epoch: null });
      expect([refused.status, refused.body.error.message]).toEqual([403, REFUSAL]);
    }
  }
  expect((await glass({}, land)).status).toBe(401);
  expect((await api(`${repo}/land`, owner, { body: { ref: 'main', commit: sha } }, down)).body.error.code).toBe('NOT_READY');
  expect((await glass(owner, { ...land, reason: ' ' })).body.error.code).toBe('INVALID_INPUT');
  expect((await glass(owner, { ...land, expected_old: sha })).status).toBe(409);

  const landed = await glass(owner, land);
  expect(landed.status).toBe(200);
  expect(landed.body).toMatchObject({ landed: true, version: 2, projection: 'deferred' });
  expect((await glass(owner, land)).body).toMatchObject({ already: true, version: 2 });

  const revert = { action: 'revert', ref: 'main', commit: sha, expected_old: sha, reason: 'bad landing' };
  const reverted = await glass(owner, revert);
  expect(reverted.status).toBe(200);
  expect(reverted.body).toMatchObject({ landed: true, version: 3, reverted: sha, check_runs_undispatched: true });
  expect((await glass(owner, revert)).body).toMatchObject({ already: true, commit: reverted.body.commit });
  expect((await api(`${repo}/blob?path=a.txt`, owner, {}, down)).body.content).toBe('one\n');

  const txlog = (await api(`${repo}/txlog`, ci, {}, down)).body.entries;
  expect(txlog.map((e: any) => [e.kind, e.actor])).toEqual([
    ['import', 'user:glass'],
    ['commit', 'break-glass:user:glass'],
    ['revert', 'break-glass:user:glass'],
  ]);
  const detail = (await api(`${repo}/commits/${sha}`, agent, {}, down)).body;
  expect(detail.break_glass.map((b: any) => [b.action, b.reason])).toEqual([
    ['land', 'check runner is down'],
    ['revert', 'bad landing'],
  ]);
  const history = (await api(`${repo}/log?ref=main`, agent, {}, down)).body.commits;
  expect(history.map((c: any) => c.break_glass)).toEqual(['revert', 'land', null]);

  // Pausing stops automation's verdicts and landings; the owner and reads carry on.
  expect((await glass(owner, { action: 'pause_automation', reason: 'agents misbehaving' })).body.paused).toBe(true);
  const verdict = await api(`${repo}/commits/${sha}/checks`, ci, { body: { name: 'unit', status: 'pass' } }, down);
  expect([verdict.status, verdict.body.error.code]).toEqual([423, 'AUTOMATION_PAUSED']);
  expect((await api(repo, owner, {}, down)).body.automation.paused.reason).toBe('agents misbehaving');
  expect((await glass(owner, { action: 'resume_automation', reason: 'fixed' })).body.paused).toBe(false);
  expect((await api(`${repo}/commits/${sha}/checks`, ci, { body: { name: 'unit', status: 'pass' } }, down)).status).toBe(200);
});

it('is not an MCP tool, even for an owner session', async () => {
  const owner = { cookie: await signup('glassmcp') };
  const created = await api('/repos', owner, { body: { policy: { required_checks: [], approvals: 0 }, files: [file('a.txt', 'a\n')], author } });
  const rpc = async (method: string, params?: unknown) => {
    const response = await platformFetch(
      new Request(`https://yoneda/api/v1/repos/${created.body.id}/mcp`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: owner.cookie, 'MCP-Protocol-Version': '2025-06-18' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      }),
      scoped,
    );
    return response.json<any>();
  };
  const tools = (await rpc('tools/list')).result.tools.map((t: any) => t.name);
  expect(tools.length).toBeGreaterThan(10);
  expect(tools.filter((name: string) => /break|glass|recover/.test(name))).toEqual([]);
  const called = await rpc('tools/call', { name: 'break_glass', arguments: { action: 'pause_automation', reason: 'x' } });
  expect(called.result.isError).toBe(true);
});
