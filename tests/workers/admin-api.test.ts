// The operators' admin API (`/api/v1/admin`) and account index through the real account and
// repository authorities and D1 (workerd): who is an operator (an ADMIN_ACCOUNTS session or
// the owner token; never a token or another account), the index row a new account writes,
// the backfill, suspension refusing sign-in, sessions, tokens and Git until lifted, credit
// grants through a stand-in managed Worker, operator quarantine, and an audit row per action.
import { createExecutionContext } from 'cloudflare:test';
import { expect, it, vi } from 'vitest';
import { accountRoute } from '../../cloudflare/worker/accounts';
import { PlatformEntrypoint } from '../../cloudflare/worker/platform-entrypoint';
import { platformFetch } from '../../cloudflare/worker/platform-routes';
import type { Env } from '../../cloudflare/worker/types';
import { api, author, bindings, file, queued, scoped, signup, usePlatformFixture } from './repo-fixture';

usePlatformFixture();

const OWNER = { token: 'local-test-owner' };
const operators = (extra: Partial<Env> = {}) =>
  ({ ...scoped, ADMIN_ACCOUNTS: 'boss, other_op', ...extra }) as unknown as Env;
const rows = async () =>
  (await bindings.INDEX.prepare('SELECT * FROM platform_accounts ORDER BY account').all<any>())
    .results;
const audits = async () =>
  (await bindings.INDEX.prepare('SELECT actor,action,target FROM admin_audit ORDER BY id').all<any>())
    .results;
async function token(cookie: string, scopes = ['repo:read', 'repo:write']) {
  return (await api('/tokens', { cookie }, { body: { name: 'cli', scopes } })).body.token as string;
}
async function login(name: string, target: Env) {
  const req = new Request('https://yoneda/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: name, password: 'long platform test password' }),
  });
  return (await accountRoute(req, target)) as Response;
}
/** A sign-up whose account-created hook has finished when it answers (no waitUntil lent). */
async function signupNow(name: string) {
  const req = new Request('https://yoneda/api/auth/signup', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: `${name}@example.com`, password: 'long platform test password' }),
  });
  const answer = (await accountRoute(req, scoped)) as Response;
  expect(answer.status).toBe(200);
  return (answer.headers.get('set-cookie') ?? '').split(';')[0];
}
async function session(cookie: string, target: Env) {
  const req = new Request('https://yoneda/api/auth/session', { headers: { cookie } });
  return ((await accountRoute(req, target)) as Response).json<any>();
}

it('indexes a new account once, with its provider, and queues the sign-up notice', async () => {
  const platform = new PlatformEntrypoint(createExecutionContext(), scoped);
  const front = { ...scoped, PLATFORM_QUEUE: undefined, PLATFORM: platform } as unknown as Env;
  const req = new Request('https://yoneda/api/auth/signup', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'newbie@example.com', password: 'long platform test password' }),
  });
  expect(((await accountRoute(req, front)) as Response).status).toBe(200);
  const [row] = (await rows()).filter((r: any) => r.account === 'newbie');
  expect(row).toMatchObject({ provider: 'email', handle: 'newbie', email_named: 0, suspended_at: null });
  expect(Date.now() - row.created_at).toBeLessThan(60_000);
  const kinds = queued.map((j) => j.kind);
  expect(kinds).toContain('admin_signup_notice');
  expect(kinds).toContain('account_welcome');
  // A repeat (a redelivered hook) and a sign-in add nothing.
  await platform.accountCreated('newbie', { provider: 'github' });
  expect((await login('newbie', front)).status).toBe(200);
  expect((await rows()).filter((r: any) => r.account === 'newbie')).toEqual([row]);
  // An account without an address gets the row and notice, no welcome.
  queued.length = 0;
  await platform.accountCreated('quiet', { provider: 'google', welcome: false });
  expect(queued.map((j) => j.kind)).toEqual(['admin_signup_notice']);
});

it('answers operators only: an operator session or the owner token, never a token', async () => {
  const boss = await signup('boss');
  const user = await signup('plain_user');
  const bossToken = await token(boss);
  const target = operators();
  const paths = ['/admin/overview', '/admin/accounts', '/admin/accounts/plain_user', '/admin/repos', '/admin/signups', '/admin/audit'];
  for (const path of paths) {
    expect((await api(path, { cookie: user }, {}, target)).status, path).toBe(403);
    expect((await api(path, { token: bossToken }, {}, target)).status, path).toBe(403);
    expect((await api(path, {}, {}, target)).status, path).toBe(401);
    expect((await api(path, { cookie: boss }, {}, target)).status, path).toBe(200);
    expect((await api(path, OWNER, {}, target)).status, path).toBe(200);
    // Unset, nobody's session is an operator.
    expect((await api(path, { cookie: boss }, {}, scoped)).status, path).toBe(403);
  }
  for (const action of ['suspend', 'unsuspend', 'credit'])
    expect((await api(`/admin/accounts/boss/${action}`, { cookie: user }, { body: { usd: 1 } }, target)).status).toBe(403);
  expect(await audits()).toEqual([]);
  // The session answer's hint.
  expect((await session(boss, target)).is_admin).toBe(true);
  expect((await session(user, target)).is_admin).toBe(false);
});

it('lists accounts and repositories, shows an account with its email, and pages', async () => {
  const boss = await signup('boss');
  const owner = await signup('lister');
  const created = await api('/repos', { cookie: owner }, { body: { name: 'shown', files: [file('README.md', '# shown\n')], author } });
  expect(created.status).toBe(200);
  const target = operators();
  const overview = (await api('/admin/overview', { cookie: boss }, {}, target)).body;
  expect(overview.accounts.total).toBe(2);
  expect(overview.accounts.new_24h).toBe(2);
  expect(overview.repos).toEqual({ public: 0, private: 1 });
  expect(overview.signups_per_day).toHaveLength(30);
  expect(overview.signups_per_day.at(-1).count).toBe(2);
  const listed = (await api('/admin/accounts?q=list', { cookie: boss }, {}, target)).body;
  expect(listed.items.map((a: any) => [a.account, a.repos])).toEqual([['lister', 1]]);
  expect(listed.next).toBeNull();
  const detail = (await api('/admin/accounts/lister', { cookie: boss }, {}, target)).body;
  expect(detail).toMatchObject({ account: 'lister', email: 'lister@example.com', handle: 'lister', password: true, tokens: 0, credit: null });
  expect(detail.repos.map((r: any) => r.name)).toEqual(['shown']);
  // Its session's API calls marked it seen (to the day).
  expect(detail.last_seen_at).toEqual(expect.any(Number));
  const repos = (await api('/admin/repos', { cookie: boss }, {}, target)).body;
  expect(repos.items).toEqual([expect.objectContaining({ id: created.body.id, name: 'shown', owner: 'lister', visibility: 'private' })]);
  expect((await api('/admin/accounts/nobody_here', { cookie: boss }, {}, target)).status).toBe(404);
  // Emails stay out of every non-admin answer about the account.
  expect(JSON.stringify((await api('/repos', { cookie: owner })).body)).not.toContain('lister@example.com');
});

it('suspends: sign-in, sessions, tokens and Git are refused until unsuspended, and audited', async () => {
  const boss = await signup('boss');
  const cookie = await signup('target_user');
  const pat = await token(cookie);
  const repo = (await api('/repos', { cookie }, { body: { name: 'held', files: [file('README.md', '# held\n')], author } })).body.id;
  const target = operators();
  const suspended = await api('/admin/accounts/target_user/suspend', { cookie: boss }, { body: {} }, target);
  expect(suspended.status).toBe(200);
  expect(suspended.body.suspended_at).toEqual(expect.any(Number));
  expect((await rows()).find((r: any) => r.account === 'target_user').suspended_at).toBe(suspended.body.suspended_at);

  const refusedLogin = await login('target_user', target);
  expect([refusedLogin.status, (await refusedLogin.json<any>()).error.code]).toEqual([403, 'ACCOUNT_SUSPENDED']);
  expect(await session(cookie, target)).toEqual({ authenticated: false, suspended: true });
  expect((await api('/repos', { cookie }, {}, target)).status).toBe(401);
  const byToken = await api('/repos', { token: pat }, {}, target);
  expect([byToken.status, byToken.body.error.code]).toEqual([403, 'ACCOUNT_SUSPENDED']);
  const basic = { authorization: `Basic ${btoa(`x:${pat}`)}` };
  const git = await platformFetch(
    new Request(`https://yoneda/git/${repo}.git/info/refs?service=git-receive-pack`, { headers: basic }),
    target,
  );
  expect(git.status).toBe(403);
  // An operator never suspends itself.
  expect((await api('/admin/accounts/boss/suspend', { cookie: boss }, { body: {} }, target)).status).toBe(400);

  const lifted = await api('/admin/accounts/target_user/unsuspend', { cookie: boss }, { body: {} }, target);
  expect(lifted.body).toEqual({ account: 'target_user', suspended_at: null });
  expect((await api('/repos', { cookie }, {}, target)).status).toBe(200);
  expect((await api('/repos', { token: pat }, {}, target)).status).toBe(200);
  expect((await login('target_user', target)).status).toBe(200);
  expect(await audits()).toEqual([
    { actor: 'boss', action: 'account.suspend', target: 'target_user' },
    { actor: 'boss', action: 'account.unsuspend', target: 'target_user' },
  ]);
});

it('grants credit through the managed Worker with its bearer kept server-side', async () => {
  const boss = await signup('boss');
  await signup('credited');
  const calls: { url: string; method: string; auth: string | null; body: any }[] = [];
  const MANAGED = {
    fetch: async (url: string, init: RequestInit) => {
      const auth = new Headers(init.headers).get('authorization');
      calls.push({ url, method: init.method ?? 'GET', auth, body: init.body ? JSON.parse(String(init.body)) : null });
      return Response.json(init.method === 'POST' ? { balance: { balance: 5_000_000 }, resumed: 0 } : { balance: { balance: 0 }, entries: [] });
    },
  };
  const target = operators({ MANAGED: MANAGED as unknown as Fetcher, MANAGED_ADMIN_TOKEN: 'managed-secret' });
  const granted = await api('/admin/accounts/credited/credit', { cookie: boss }, { body: { usd: 5, note: 'welcome' } }, target);
  expect(granted.status).toBe(200);
  expect(granted.body.balance.balance).toBe(5_000_000);
  expect(calls[0]).toEqual({
    url: 'https://managed/admin/accounts/credited/credit',
    method: 'POST',
    auth: 'Bearer managed-secret',
    body: { usd: 5, note: 'welcome' },
  });
  expect(JSON.stringify(granted.body)).not.toContain('managed-secret');
  for (const usd of [0, -1, 1001, 'x'])
    expect((await api('/admin/accounts/credited/credit', { cookie: boss }, { body: { usd } }, target)).status).toBe(400);
  expect((await api('/admin/accounts/credited', { cookie: boss }, {}, target)).body.credit).toEqual({ balance: { balance: 0 }, entries: [] });
  // Without the binding or bearer, a grant is refused and nothing is audited for it.
  expect((await api('/admin/accounts/credited/credit', { cookie: boss }, { body: { usd: 5 } }, operators())).status).toBe(400);
  expect(await audits()).toEqual([{ actor: 'boss', action: 'account.credit', target: 'credited' }]);
});

it('quarantines and releases repository content as the owner, audited', async () => {
  const boss = await signup('boss');
  const owner = await signup('repo_owner');
  const repo = (await api('/repos', { cookie: owner }, { body: { name: 'leaky', files: [file('secret.txt', 'oops\n')], author } })).body.id;
  const target = operators();
  const made = await api(`/admin/repos/${repo}/quarantine`, { cookie: boss }, { body: { path: 'secret.txt', reason: 'reported leak' } }, target);
  expect(made.status).toBe(200);
  const detail = (await api(`/admin/repos/${repo}`, { cookie: boss }, {}, target)).body;
  expect(detail).toMatchObject({ id: repo, owner: 'repo_owner' });
  expect(detail.quarantines).toHaveLength(1);
  const record = detail.quarantines[0].id;
  const released = await api(`/admin/repos/${repo}/quarantine/${record}/release`, { cookie: boss }, { body: {} }, target);
  expect(released.status).toBe(200);
  expect(await audits()).toEqual([
    { actor: 'boss', action: 'repo.quarantine', target: repo },
    { actor: 'boss', action: 'repo.release', target: repo },
  ]);
});

it('backfills accounts the other projections know, once', async () => {
  const one = await signupNow('early_one');
  await api('/repos', { cookie: one }, { body: { name: 'r1', files: [file('a', 'a\n')], author } });
  const two = await signupNow('early_two');
  await token(two);
  await signupNow('unknown_three'); // no repository, handle row or token: found only going forward
  await bindings.INDEX.prepare('DELETE FROM platform_accounts').run();
  const first = await api('/admin/backfill', OWNER, { body: {} }, operators());
  expect(first.body).toMatchObject({ added: 2, next: null });
  expect((await rows()).map((r: any) => [r.account, r.provider])).toEqual([
    ['early_one', 'email'],
    ['early_two', 'email'],
  ]);
  expect((await api('/admin/backfill', OWNER, { body: {} }, operators())).body.added).toBe(0);
  expect((await rows()).length).toBe(2);
  // The account no projection knows joins the index at its next session check.
  const three = await signupNow('unknown_four');
  await bindings.INDEX.prepare("DELETE FROM platform_accounts WHERE account='unknown_four'").run();
  await api('/repos', { cookie: three });
  // After the answer (no waitUntil here: it runs alongside).
  await vi.waitFor(async () =>
    expect((await rows()).find((r: any) => r.account === 'unknown_four')).toMatchObject({
      provider: 'email',
      last_seen_at: expect.any(Number),
    }),
  );
  expect((await audits()).map((a: any) => [a.actor, a.action])).toEqual([
    ['_admin', 'accounts.backfill'],
    ['_admin', 'accounts.backfill'],
  ]);
});

it('reports site traffic to operators only, and says when it is not configured', async () => {
  const boss = await signup('boss');
  const user = await signup('plain_user');
  const target = operators();
  expect((await api('/admin/traffic?days=7', { cookie: user }, {}, target)).status).toBe(403);
  // No account id, dataset or read token here.
  const off = await api('/admin/traffic?days=30', { cookie: boss }, {}, target);
  expect([off.status, off.body]).toEqual([200, { ok: false, reason: 'not_configured' }]);
  const configured = operators({
    CF_ACCOUNT_ID: '0123456789abcdef0123456789abcdef',
    SITE_EVENTS_DATASET: 'site_events_test',
    ANALYTICS_READ_TOKEN: 'read-token',
  });
  const sql: string[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
    sql.push(String(init?.body));
    return Response.json({ data: [] });
  });
  const on = await api('/admin/traffic?days=7', { cookie: boss }, {}, configured);
  expect(on.status).toBe(200);
  expect(on.body).toMatchObject({ ok: true, traffic: { days: 7 } });
  expect(sql.some((q) => q.includes("INTERVAL '7' DAY"))).toBe(true);
  // Any other window answers 30 days.
  expect((await api('/admin/traffic?days=9', { cookie: boss }, {}, configured)).body.traffic.days).toBe(30);
});
