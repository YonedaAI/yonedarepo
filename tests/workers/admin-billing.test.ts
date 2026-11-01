// The operators' billing routes in the platform Worker, through a stand-in managed Worker: who may
// use them, the reason (required, capped, scanned by the platform's own secret rules), the audit
// row written before the money moves and updated after, and the nightly trigger. The refund
// itself, Stripe and the ledger are tests/managed/admin-*.test.ts.
import { createExecutionContext } from 'cloudflare:test';
import { expect, it, vi } from 'vitest';
import { PlatformEntrypoint } from '../../cloudflare/worker/platform-entrypoint';
import type { Env } from '../../cloudflare/worker/types';
import { api, bindings, scoped, signup, usePlatformFixture } from './repo-fixture';

usePlatformFixture();

type Call = { url: string; method: string; auth: string | null; body: any; audit: any[] };
const auditRows = async () =>
  (await bindings.INDEX.prepare('SELECT actor,action,target,detail FROM admin_audit ORDER BY id').all<any>()).results.map((r: any) => ({
    ...r,
    detail: r.detail ? JSON.parse(r.detail) : null,
  }));

/** A managed Worker answering `reply`, which records the audit log as each request arrives. */
function managed(reply: (call: Call) => Response = () => Response.json({ refund: { status: 'succeeded' }, balance: { balance: 15_000_000 } })) {
  const calls: Call[] = [];
  const MANAGED = {
    fetch: async (url: string, init: RequestInit) => {
      const call = {
        url,
        method: init.method ?? 'GET',
        auth: new Headers(init.headers).get('authorization'),
        body: init.body ? JSON.parse(String(init.body)) : null,
        audit: await auditRows(),
      };
      calls.push(call);
      return reply(call);
    },
  };
  return { calls, MANAGED: MANAGED as unknown as Fetcher };
}
const operators = (extra: Partial<Env> = {}) =>
  ({ ...scoped, ADMIN_ACCOUNTS: 'boss', ADMIN_BILLING: 'on', MANAGED_ADMIN_TOKEN: 'managed-secret', ...extra }) as unknown as Env;
const refund = { id: 'refund-request-1', top_up: 'topup-1', usd: 5, reason: 'Customer asked' };
const POSTS = ['refund', 'credit', 'auto-top-up-off', 'remove-card', 'pause'];

it('refuses everyone but an operator, on every route, before anything reaches the managed Worker', async () => {
  const user = await signup('plain_user');
  await signup('target_user');
  const boss = await signup('boss');
  const { calls, MANAGED } = managed();
  const target = operators({ MANAGED });
  const token = (await api('/tokens', { cookie: boss }, { body: { name: 'cli', scopes: ['repo:read', 'repo:write'] } })).body.token as string;
  for (const auth of [{ cookie: user }, { token }, {}]) {
    for (const path of ['', '/ledger', '/usage'])
      expect((await api(`/admin/accounts/target_user/billing${path}`, auth, {}, target)).status, path).toBeGreaterThanOrEqual(401);
    for (const action of POSTS)
      expect((await api(`/admin/accounts/target_user/billing/${action}`, auth, { body: refund }, target)).status, action).toBeGreaterThanOrEqual(401);
  }
  expect(calls).toEqual([]);
  expect(await auditRows()).toEqual([]);
});

it('does not exist until ADMIN_BILLING is on', async () => {
  const boss = await signup('boss');
  await signup('target_user');
  const { calls, MANAGED } = managed();
  const off = operators({ MANAGED, ADMIN_BILLING: undefined });
  expect((await api('/admin/accounts/target_user/billing', { cookie: boss }, {}, off)).status).toBe(404);
  expect((await api('/admin/accounts/target_user/billing/refund', { cookie: boss }, { body: refund }, off)).status).toBe(404);
  expect((await api('/admin/accounts/target_user', { cookie: boss }, {}, off)).body.billing).toBe(false);
  expect(calls.filter((c) => c.url.includes('/billing'))).toEqual([]);
  expect((await api('/admin/accounts/target_user', { cookie: boss }, {}, operators({ MANAGED }))).body.billing).toBe(true);
});

it('writes the audit row before the money moves and updates it after', async () => {
  const boss = await signup('boss');
  await signup('target_user');
  const { calls, MANAGED } = managed();
  const res = await api('/admin/accounts/target_user/billing/refund', { cookie: boss }, { body: { ...refund, spent_override: true } }, operators({ MANAGED }));
  expect(res.status).toBe(200);
  expect(calls).toHaveLength(1);
  expect(calls[0].url).toBe('https://managed/admin/accounts/target_user/billing/refund');
  expect(calls[0].auth).toBe('Bearer managed-secret');
  expect(calls[0].audit).toEqual([
    {
      actor: 'boss',
      action: 'billing.refund',
      target: 'target_user',
      detail: { reason: 'Customer asked', usd: 5, request: 'refund-request-1', top_up: 'topup-1', spent_override: true, allow_negative: false, outcome: 'pending' },
    },
  ]);
  expect(await auditRows()).toEqual([
    expect.objectContaining({ detail: expect.objectContaining({ outcome: 'succeeded', balance: 15_000_000, usd: 5 }) }),
  ]);
  expect(JSON.stringify(res.body)).not.toContain('managed-secret');
});

it('takes the actor from the session, never the body, and passes only known fields', async () => {
  const boss = await signup('boss');
  await signup('target_user');
  const { calls, MANAGED } = managed();
  await api('/admin/accounts/target_user/billing/refund', { cookie: boss }, { body: { ...refund, actor: 'someone_else', extra: 'x' } }, operators({ MANAGED }));
  expect(calls[0].body.actor).toBe('boss');
  expect(calls[0].body.extra).toBeUndefined();
});

it('records a refusal, with its code, and answers it as the managed Worker did', async () => {
  const boss = await signup('boss');
  await signup('target_user');
  const { MANAGED } = managed(() => Response.json({ error: { code: 'NEGATIVE_BALANCE', message: 'The balance would go to -$15.00' } }, { status: 400 }));
  const res = await api('/admin/accounts/target_user/billing/refund', { cookie: boss }, { body: refund }, operators({ MANAGED }));
  expect(res.status).toBe(400);
  expect(res.body.error).toMatchObject({ code: 'NEGATIVE_BALANCE', message: 'The balance would go to -$15.00' });
  expect((await auditRows())[0].detail).toMatchObject({ outcome: 'refused', code: 'NEGATIVE_BALANCE' });
});

it('answers NOT_CONFIGURED as 503, and a lost managed Worker as a failure the audit row shows', async () => {
  const boss = await signup('boss');
  await signup('target_user');
  const { MANAGED } = managed(() => Response.json({ error: { code: 'NOT_CONFIGURED', message: 'Refunds are not set up here' } }, { status: 503 }));
  expect((await api('/admin/accounts/target_user/billing/refund', { cookie: boss }, { body: refund }, operators({ MANAGED }))).status).toBe(503);
  const lost = { fetch: async () => { throw new Error('network'); } } as unknown as Fetcher;
  const res = await api('/admin/accounts/target_user/billing/refund', { cookie: boss }, { body: refund }, operators({ MANAGED: lost }));
  expect(res.status).toBe(502);
  expect((await auditRows()).at(-1).detail).toMatchObject({ outcome: 'unknown' });
});

it('requires a reason on every action, caps it, and scans it with the platform’s rules', async () => {
  const boss = await signup('boss');
  await signup('target_user');
  const { calls, MANAGED } = managed();
  const target = operators({ MANAGED });
  for (const action of POSTS) {
    for (const reason of [undefined, '', '   ', 'x'.repeat(501), 7]) {
      const res = await api(`/admin/accounts/target_user/billing/${action}`, { cookie: boss }, { body: { ...refund, reason } }, target);
      expect(res.status, `${action} ${String(reason).slice(0, 8)}`).toBe(400);
    }
    const key = ['sk', 'live', 'a1B2c3D4e5F6g7H8i9J0k1L2'].join('_');
    const res = await api(`/admin/accounts/target_user/billing/${action}`, { cookie: boss }, { body: { ...refund, reason: `card key ${key}` } }, target);
    expect(res.status, action).toBe(422);
    expect(res.body.error.code).toBe('SECRET_DETECTED');
    expect(JSON.stringify(res.body)).not.toContain(key);
  }
  expect(calls).toEqual([]);
  expect(await auditRows()).toEqual([]);
});

it('answers reads and passes paging through, and refuses an unknown account', async () => {
  const boss = await signup('boss');
  await signup('target_user');
  const { calls, MANAGED } = managed(() => Response.json({ items: [], next: null }));
  const target = operators({ MANAGED });
  expect((await api('/admin/accounts/target_user/billing/ledger?before=9&limit=5', { cookie: boss }, {}, target)).status).toBe(200);
  expect(calls[0]).toMatchObject({ url: 'https://managed/admin/accounts/target_user/billing/ledger?before=9&limit=5', method: 'GET' });
  expect((await api('/admin/accounts/nobody_here/billing', { cookie: boss }, {}, target)).status).toBe(404);
  expect((await api('/admin/accounts/target_user/billing/nonsense', { cookie: boss }, {}, target)).status).toBe(404);
});

it('says when the managed Worker is not reachable from here', async () => {
  const boss = await signup('boss');
  await signup('target_user');
  const res = await api('/admin/accounts/target_user/billing', { cookie: boss }, {}, operators({ MANAGED: undefined }));
  expect(res.status).toBe(503);
  expect(res.body.error.code).toBe('NOT_CONFIGURED');
});

it('starts the reconcile once a night, only with ADMIN_BILLING on', async () => {
  const { calls, MANAGED } = managed(() => Response.json({ queued: true }, { status: 202 }));
  const tick = (env: Env, at: string) =>
    new PlatformEntrypoint(createExecutionContext(), env).scheduled({ scheduledTime: Date.parse(at) } as ScheduledController);
  vi.spyOn(console, 'error').mockImplementation(() => {});
  await tick(operators({ MANAGED, ADMIN_BILLING: 'off' }), '2026-11-01T03:17:00Z');
  expect(calls).toEqual([]);
  await tick(operators({ MANAGED }), '2026-11-01T03:16:00Z');
  await tick(operators({ MANAGED }), '2026-11-01T04:17:00Z');
  expect(calls).toEqual([]);
  await tick(operators({ MANAGED }), '2026-11-01T03:17:00Z');
  expect(calls).toHaveLength(1);
  expect(calls[0]).toMatchObject({ url: 'https://managed/admin/billing/reconcile', method: 'POST', auth: 'Bearer managed-secret' });
});
