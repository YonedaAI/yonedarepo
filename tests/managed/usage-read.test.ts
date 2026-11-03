// Actual managed Durable Object records; platform admission is simulated, no model is called.
import { afterEach, expect, it, vi } from 'vitest';
import { managedFetch } from '../../cloudflare/managed/index';
import { repoStub } from '../../cloudflare/managed/repo-agents';
import { harness, HEAD_A, type Harness, newRepo } from './fake';

afterEach(() => vi.restoreAllMocks());
const read = (
  h: Harness,
  path = '/runs?limit=100',
  cookie = 'session=owner',
  workspace = h.platform.account,
) =>
  managedFetch(
    new Request(`https://site.example.com/api/managed/workspaces/${workspace}${path}`, {
      headers: { cookie },
    }),
    h.env,
  );

async function recorded() {
  const h = harness(newRepo());
  const stub = repoStub(h.env, h.platform.repo);
  await stub.setEnabled('code-review', true, 'fixture owner');
  const claim = await stub.claim(h.platform.repo, 'code-review', 1, HEAD_A, {
    harness: 'codex',
    provider: 'codex',
    model: 'gpt-5.6-luna',
  });
  if (!claim) throw new Error('Fixture claim failed');
  await stub.recordCall(claim.run, 1000, 200, 30000);
  await stub.recordContainer(claim.run, 90, 10000);
  await stub.finish(claim.run, claim.attempt, 'passed', { value: 'pass' });
  return { h, stub, claim };
}

it('returns recorded tokens, execution, cost and outcomes without a provider or billing read', async () => {
  const { h, claim } = await recorded();
  const res = await read(h);
  expect(res.status).toBe(200);
  expect(res.headers.get('cache-control')).toBe('no-store');
  expect((await res.json<any>()).runs).toEqual([
    expect.objectContaining({
      id: claim.run,
      calls: 1,
      input_tokens: 1000,
      output_tokens: 200,
      container_seconds: 90,
      cost_usd: 0.04,
      status: 'passed',
      value: 'pass',
    }),
  ]);
  expect(h.created).toHaveLength(0);
  expect(h.harness.started).toHaveLength(0);
  expect(h.platform.requests.every((r) => r.method === 'GET')).toBe(true);
  expect((await (await read(h, '/runs?agent=security-review&limit=100')).json<any>()).runs).toEqual(
    [],
  );
});

it('freshly denies a reader, signed-out caller and foreign workspace after an owner read', async () => {
  const { h } = await recorded();
  expect((await read(h)).status).toBe(200);
  expect((await read(h, undefined, 'session=reader')).status).toBe(403);
  expect((await read(h, undefined, '')).status).toBe(401);
  expect((await read(h, undefined, 'session=owner', 'foreign_workspace')).status).toBe(403);
});

it('drops a no-longer-owned repository and keeps empty history empty', async () => {
  const { h } = await recorded();
  expect((await (await read(h)).json<any>()).runs).toHaveLength(1);
  h.platform.repos.pop();
  expect((await (await read(h)).json<any>()).runs).toEqual([]);
  expect((await (await read(harness(newRepo()))).json<any>()).runs).toEqual([]);
});
