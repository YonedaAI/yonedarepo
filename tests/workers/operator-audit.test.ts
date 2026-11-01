// The operator log with OPERATOR_AUDIT on, through the real routes and D1 (workerd): People and
// System apart, filters, what a row holds about its request and what it never holds, attempts that
// failed or were refused, a purge's way to its end, and staff reading a customer's private
// repository.
import { env as bound } from 'cloudflare:workers';
import { beforeEach, expect, it } from 'vitest';
import adminAudit from '../../cloudflare/migrations/0015_admin_audit_detail.sql?raw';
import { audit, auditBegin, auditEnd } from '../../cloudflare/worker/platform-admin-queries';
import {
  deniedAttempt,
  forgetAttempts,
  settlePurge,
} from '../../cloudflare/worker/platform-operator-audit';
import { inScope } from '../../cloudflare/worker/request-scope';
import type { Credentials } from '../../cloudflare/worker/repo-ops';
import type { Env } from '../../cloudflare/worker/types';
import { api, author, file, scoped, signup, usePlatformFixture } from './repo-fixture';

usePlatformFixture();
beforeEach(forgetAttempts);

const on = { ...scoped, OPERATOR_AUDIT: 'on', ADMIN_ACCOUNTS: 'audit_boss' } as unknown as Env;
const owner = { token: 'local-test-owner' };
const db = (bound as unknown as { INDEX: D1Database }).INDEX;
const rows = async () =>
  (await db.prepare('SELECT * FROM admin_audit ORDER BY id').all<Record<string, unknown>>()).results;
const settle = () => new Promise((r) => setTimeout(r, 20));

async function repository(name: string) {
  const cookie = await signup(name);
  const made = await api('/repos', { cookie }, { body: { name, files: [file('a.md', 'a\n')], author } });
  expect(made.status, JSON.stringify(made.body)).toBe(200);
  return { cookie, id: made.body.id as string };
}

it('keeps a row with its request, and never an address or user agent', async () => {
  const req = new Request('https://yoneda/x', {
    headers: { origin: 'https://Dev.yonedarepo.com', 'cf-ray': '0123456789abcdef-LHR', 'user-agent': 'Secret/1.0', 'cf-connecting-ip': '203.0.113.9' },
    cf: { timezone: 'Europe/Paris' },
  } as RequestInit);
  await inScope({ req }, () => audit(on, 'alice', 'account.suspend', 'bob'));
  const [row] = await rows();
  expect(row).toMatchObject({
    actor: 'alice',
    outcome: 'success',
    actor_kind: 'person',
    origin: 'dev.yonedarepo.com',
    time_zone: 'Europe/Paris',
    request_id: '0123456789abcdef-LHR',
  });
  expect(JSON.stringify(row)).not.toMatch(/203\.0\.113|Secret\/1/);
});

it('says a request with no page came from a script', async () => {
  await inScope({ req: new Request('https://yoneda/x') }, () => audit(on, 'alice', 'a.b', 't'));
  expect((await rows())[0].origin).toBe('script');
});

it('splits People from System, with old rows told apart by their actor', async () => {
  await audit(on, 'alice', 'account.suspend', 'bob');
  await audit(on, '_admin', 'repo.purge_now', 'r1');
  await audit(on, 'alice', 'accounts.backfill', '-');
  await db
    .prepare("INSERT INTO admin_audit(at,actor,action,target) VALUES(?,'_admin','repo.purge_now','old')")
    .bind(Date.now())
    .run();
  const log = async (view: string) =>
    (await api(`/admin/audit?view=${view}`, owner, {}, on)).body.items.map((r: any) => r.target);
  expect(await log('people')).toEqual(['bob']);
  expect((await log('system')).sort()).toEqual(['-', 'old', 'r1']);
});

it('filters by operator, action, target, outcome and date, with wildcards taken literally', async () => {
  await audit(on, 'alice', 'account.suspend', 'bob');
  await audit(on, 'carol', 'account.credit', 'dave');
  await db.prepare("UPDATE admin_audit SET at=? WHERE actor='carol'").bind(Date.UTC(2026, 0, 2, 12)).run();
  const asked = async (query: string) => {
    const answer = await api(`/admin/audit?${query}`, owner, {}, on);
    expect(answer.status, JSON.stringify(answer.body)).toBe(200);
    return answer.body.items.map((r: any) => r.actor);
  };
  expect(await asked('actor=ALI')).toEqual(['alice']);
  expect(await asked('action=account.cr')).toEqual(['carol']);
  expect(await asked('target=da')).toEqual(['carol']);
  expect(await asked('actor=%25')).toEqual([]);
  expect((await asked('outcome=success')).length).toBe(2);
  expect(await asked('outcome=failed')).toEqual([]);
  expect(await asked('from=2026-01-02&to=2026-01-02')).toEqual(['carol']);
  expect(await asked('to=2026-01-01')).toEqual([]);
});

it('never shows a key that looks like a secret, however it was written', async () => {
  await audit(on, 'alice', 'x.y', 't', { note: 'fine', api_key: 'k', nested: { access_token: 't' } });
  const [item] = (await api('/admin/audit', owner, {}, on)).body.items;
  expect(item.detail).toEqual({ note: 'fine', nested: {} });
});

it('records one refused knock per caller, and no credential', async () => {
  const cookie = await signup('audit_stranger');
  for (let i = 0; i < 3; i++) expect((await api('/admin/audit', { cookie }, {}, on)).status).toBe(403);
  await settle();
  const denied = (await rows()).filter((r) => r.action === 'admin.denied');
  expect(denied).toHaveLength(1);
  expect(denied[0]).toMatchObject({ actor: 'audit_stranger', target: 'audit', outcome: 'denied' });
});

it('names a repository token only as one, and keeps strangers from filling the table', async () => {
  const token = { _token: 'yrp_secret_value' } as Credentials;
  await deniedAttempt(on, token, 'audit');
  expect((await rows())[0].actor).toBe('repository token');
  expect(JSON.stringify(await rows())).not.toContain('yrp_secret');
  for (let i = 0; i < 70; i++)
    await deniedAttempt(on, { _pat: { workspace: `u${i}` } } as unknown as Credentials, 'audit');
  expect((await rows()).length).toBe(60);
});

it('records an action that failed, and not a read', async () => {
  const failed = await api('/admin/accounts/nobody_here/credit', owner, { body: { usd: 5 } }, on);
  expect(failed.status).toBe(404);
  expect((await api('/admin/repos/r00000000000000000000', owner, {}, on)).status).toBe(404);
  await settle();
  const [row] = (await rows()).filter((r) => r.action === 'admin.failed');
  expect(row).toMatchObject({ outcome: 'failed', target: 'nobody_here' });
  expect(JSON.parse(String(row.detail))).toMatchObject({ code: 'NOT_FOUND', action: 'credit' });
  expect((await rows()).filter((r) => r.action === 'admin.failed')).toHaveLength(1);
});

it('follows a purge from requested to its end, whichever way it goes', async () => {
  const row = async () => (await rows()).find((r) => r.action === 'repo.purge_now');
  const id = await auditBegin(on, 'alice', 'repo.purge_now', 'r1', {});
  expect((await row())?.outcome).toBe('requested');
  await auditEnd(on, id, { queued: true });
  expect((await row())?.outcome).toBe('queued');
  await settlePurge(on, 'r2', 'completed');
  expect((await row())?.outcome).toBe('queued');
  await settlePurge(on, 'r1', 'failed');
  expect((await row())?.outcome).toBe('failed');
  await settlePurge(on, 'r1', 'completed');
  expect((await row())?.outcome).toBe('completed');
  await settlePurge(on, 'r1', 'failed');
  expect((await row())?.outcome).toBe('completed');
});

it('purges through the route, as queued', async () => {
  const s = await repository('audit_purged');
  expect((await api(`/repos/${s.id}?confirm=audit_purged`, s, { method: 'DELETE' }, on)).status).toBe(200);
  const purged = await api(`/admin/repos/${s.id}/purge-now`, owner, { method: 'POST', body: {} }, on);
  expect(purged.status, JSON.stringify(purged.body)).toBe(200);
  expect((await rows()).find((r) => r.action === 'repo.purge_now')).toMatchObject({ target: s.id, outcome: 'queued' });
});

it("follows an owner's purge to its end, as an operator's", async () => {
  const s = await repository('audit_owner_purged');
  const undo = { ...on, REPO_UNDO_DAYS: '30' } as unknown as Env;
  await api(`/repos/${s.id}?confirm=audit_owner_purged`, s, { method: 'DELETE' }, undo);
  expect((await api(`/repos/${s.id}/purge`, s, { body: {} }, undo)).status).toBe(200);
  const row = async () => (await rows()).find((r) => r.action === 'repo.purge_owner');
  expect(await row()).toMatchObject({ target: s.id, outcome: 'queued', actor_kind: 'person' });
  await settlePurge(on, s.id, 'completed');
  expect((await row())?.outcome).toBe('completed');
});

it('records staff opening a private repository, once, and not a public one or ours', async () => {
  const s = await repository('audit_private');
  const read = (id: string) => api(`/admin/repos/${id}`, owner, {}, on);
  expect((await read(s.id)).status).toBe(200);
  await read(s.id);
  await settle();
  const reads = async () => (await rows()).filter((r) => r.action === 'repo.staff_read');
  expect(await reads()).toHaveLength(1);
  expect((await reads())[0]).toMatchObject({ actor: '_admin', target: s.id, actor_kind: 'system' });

  const open = await repository('audit_public');
  await api(`/repos/${open.id}/visibility`, open, { method: 'PUT', body: { visibility: 'public' } }, on);
  await read(open.id);
  const ours = await repository('audit_ours');
  await db.prepare("UPDATE platform_accounts SET internal=1 WHERE account='audit_ours'").run();
  await read(ours.id);
  await settle();
  expect(await reads()).toHaveLength(1);
});

it('stays as it was with the switch off', async () => {
  await audit(scoped, 'alice', 'account.suspend', 'bob');
  const [row] = await rows();
  expect(row.outcome).toBe(null);
  const log = await api('/admin/audit', owner, {}, scoped);
  expect(log.body.detailed).toBeUndefined();
  expect(Object.keys(log.body.items[0]).sort()).toEqual(['action', 'actor', 'at', 'detail', 'id', 'target']);
  const cookie = await signup('audit_off');
  await api('/admin/audit', { cookie }, {}, scoped);
  await settle();
  expect(await rows()).toHaveLength(1);
});

it('upgrades the table from before, and refuses a second run', async () => {
  const statements = adminAudit
    .replace(/--.*$/gm, '')
    .split(';')
    .map((s) => s.trim().replaceAll('admin_audit', 'old_audit'))
    .filter(Boolean);
  await db.exec('DROP TABLE IF EXISTS old_audit');
  await db.exec('CREATE TABLE old_audit(id INTEGER PRIMARY KEY, at INTEGER, actor TEXT, action TEXT, target TEXT, detail TEXT)');
  await db.exec("INSERT INTO old_audit(at,actor,action,target) VALUES(1,'a','b','c')");
  for (const statement of statements) await db.exec(statement);
  expect(await db.prepare('SELECT outcome,actor_kind FROM old_audit').first()).toEqual({ outcome: null, actor_kind: null });
  await expect(db.exec(statements[0])).rejects.toThrow(/duplicate column/i);
  expect(await db.prepare('SELECT COUNT(*) AS n FROM old_audit').first()).toEqual({ n: 1 });
});
