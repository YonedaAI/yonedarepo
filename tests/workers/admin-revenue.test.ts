// The operators' revenue view in the platform Worker: who may read it, the switch, and that it
// is the managed Worker's answer, reached like credit with the bearer kept here. The numbers are
// tests/managed/admin-revenue.test.ts, and the platform holds none of them. The rebuild names the
// accounts, which only the platform knows.
import { expect, it, vi } from 'vitest';
import type { Env } from '../../cloudflare/worker/types';
import { api, bindings, scoped, signup, usePlatformFixture } from './repo-fixture';

usePlatformFixture();

const operators = (extra: Partial<Env> = {}) =>
  ({ ...scoped, ADMIN_ACCOUNTS: 'boss', ADMIN_BILLING: 'on', MANAGED_ADMIN_TOKEN: 'managed-secret', ...extra }) as unknown as Env;
type Call = { url: string; method: string; auth: string | null; body: any };
function managed(reply: () => Response = () => Response.json({ totals: {}, source: 'ledger' })) {
  const calls: Call[] = [];
  const MANAGED = {
    fetch: async (url: string, init: RequestInit) => {
      calls.push({ url, method: init.method ?? 'GET', auth: new Headers(init.headers).get('authorization'), body: init.body ? JSON.parse(String(init.body)) : null });
      return reply();
    },
  };
  return { calls, MANAGED: MANAGED as unknown as Fetcher };
}

it('answers operators only, before anything reaches the managed Worker', async () => {
  const user = await signup('plain_user');
  const boss = await signup('boss');
  const { calls, MANAGED } = managed();
  const target = operators({ MANAGED });
  const token = (await api('/tokens', { cookie: boss }, { body: { name: 'cli', scopes: ['repo:read', 'repo:write'] } })).body.token as string;
  for (const auth of [{ cookie: user }, { token }, {}]) {
    expect((await api('/admin/revenue', auth, {}, target)).status).toBeGreaterThanOrEqual(401);
    expect((await api('/admin/revenue/rebuild', auth, { body: {} }, target)).status).toBeGreaterThanOrEqual(401);
  }
  expect(calls).toEqual([]);
});

it('does not exist until ADMIN_BILLING is on, and the overview says which', async () => {
  const boss = await signup('boss');
  const { calls, MANAGED } = managed();
  const off = operators({ MANAGED, ADMIN_BILLING: undefined });
  expect((await api('/admin/revenue', { cookie: boss }, {}, off)).status).toBe(404);
  expect((await api('/admin/revenue/rebuild', { cookie: boss }, { body: {} }, off)).status).toBe(404);
  expect((await api('/admin/overview', { cookie: boss }, {}, off)).body.billing).toBe(false);
  expect((await api('/admin/overview', { cookie: boss }, {}, operators())).body.billing).toBe(true);
  expect(calls).toEqual([]);
});

it('is the managed Worker’s answer, with the bearer kept server-side', async () => {
  const boss = await signup('boss');
  const { calls, MANAGED } = managed();
  const res = await api('/admin/revenue?from=2026-10-01&to=2026-10-31&by=month', { cookie: boss }, {}, operators({ MANAGED }));
  expect(res.status).toBe(200);
  expect(res.body).toEqual({ totals: {}, source: 'ledger' });
  expect(calls).toEqual([
    { url: 'https://managed/admin/billing/revenue?from=2026-10-01&to=2026-10-31&by=month', method: 'GET', auth: 'Bearer managed-secret', body: null },
  ]);
  expect(JSON.stringify(res.body)).not.toContain('managed-secret');
});

it('passes on the managed Worker’s refusal, and says when it is not reachable', async () => {
  const boss = await signup('boss');
  const { MANAGED } = managed(() => Response.json({ error: { code: 'INVALID_INPUT', message: 'from is after to' } }, { status: 400 }));
  const refused = await api('/admin/revenue?from=2026-10-31&to=2026-10-01', { cookie: boss }, {}, operators({ MANAGED }));
  expect(refused.status).toBe(400);
  expect(refused.body.error.message).toBe('from is after to');
  const unbound = await api('/admin/revenue', { cookie: boss }, {}, operators({ MANAGED: undefined }));
  expect(unbound.status).toBe(503);
  expect(unbound.body.error.code).toBe('NOT_CONFIGURED');
});

it('has no rollup tables of its own: the platform’s D1 stays out of billing', async () => {
  const { results } = await bindings.INDEX.prepare("SELECT name FROM sqlite_master WHERE name LIKE 'billing%'").all();
  expect(results).toEqual([]);
});

it('rebuilds from the ledgers a page of accounts at a time, audited, orgs that own repositories included', async () => {
  const boss = await signup('boss');
  await signup('zed_user');
  await bindings.INDEX.prepare("INSERT INTO platform_repos (id, workspace, name, created_at) VALUES ('r00000000000000000001', 'some_org', 'x', 1)").run();
  const { calls, MANAGED } = managed(() => Response.json({ queued: 1 }, { status: 202 }));
  const res = await api('/admin/revenue/rebuild', { cookie: boss }, { body: {} }, operators({ MANAGED }));
  expect(res.status).toBe(200);
  expect(calls[0]).toMatchObject({ url: 'https://managed/admin/billing/rollup', auth: 'Bearer managed-secret' });
  expect(calls[0].body.accounts).toEqual(expect.arrayContaining(['some_org']));
  expect(res.body).toMatchObject({ queued: calls[0].body.accounts.length, next: null });
  const audit = await bindings.INDEX.prepare("SELECT actor, action FROM admin_audit WHERE action = 'billing.rollup_rebuild'").all<any>();
  expect(audit.results).toEqual([{ actor: 'boss', action: 'billing.rollup_rebuild' }]);
  expect(vi.isMockFunction(MANAGED.fetch)).toBe(false);
});
