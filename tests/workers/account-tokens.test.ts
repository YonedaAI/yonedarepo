// Personal access tokens (`ypat_`) and device login through the platform's public API:
// issued only to a signed-in account, verified on every request, held to their scopes,
// repository allowlist and expiry, and revocable.
import { runInDurableObject } from 'cloudflare:test';
import { expect, it } from 'vitest';
import type { Env } from '../../cloudflare/worker/types';
import { api, author, bindings, file, scoped, signup, usePlatformFixture } from './repo-fixture';

usePlatformFixture();

const DAY = 24 * 60 * 60 * 1000;
const sql = (name: string, statement: string) =>
  runInDurableObject(bindings.WORKSPACES.get(bindings.WORKSPACES.idFromName(name)), async (_instance, state) => {
    state.storage.sql.exec(statement);
  });
async function issue(cookie: string, body: Record<string, unknown>) {
  const issued = await api('/tokens', { cookie }, { body });
  expect(issued.status).toBe(200);
  return issued.body;
}
async function repo(cookie: string, name: string) {
  const created = await api('/repos', { cookie }, { body: { name, files: [file('README.md', `# ${name}\n`)], author } });
  expect(created.status).toBe(200);
  return created.body.id as string;
}

it('issues personal tokens to a signed-in account, lists them without secrets and revokes them', async () => {
  const cookie = await signup('pat_owner');
  const before = Date.now();
  const issued = await issue(cookie, { name: 'laptop', scopes: ['repo:read'], expires_days: 7 });
  expect(issued.token).toMatch(/^ypat_[A-Za-z0-9_-]{43}$/);
  expect(issued.id).toMatch(/^pat_[0-9a-f]{16}$/);
  expect(issued).toMatchObject({ name: 'laptop', scopes: ['repo:read'], repos: null });
  expect(issued.expires_at).toBeGreaterThanOrEqual(before + 7 * DAY);
  // Thirty days unless asked otherwise.
  const plain = await issue(cookie, { name: 'ci', scopes: ['repo:read', 'repo:write'] });
  expect(plain.expires_at - Date.now()).toBeGreaterThan(29 * DAY);

  const listed = await api('/tokens', { cookie });
  expect(listed.body.tokens.map((t: any) => t.name)).toEqual(['laptop', 'ci']);
  expect(JSON.stringify(listed.body)).not.toContain(issued.token);
  expect(Object.keys(listed.body.tokens[0]).sort()).toEqual(
    ['created_at', 'expires_at', 'host', 'id', 'last_used_at', 'name', 'org', 'origin', 'repos', 'scopes', 'ssh_keys'],
  );
  // Only a session issues tokens; a token cannot mint more, or list them without repo:admin.
  expect((await api('/tokens', { token: issued.token }, { body: { name: 'x', scopes: ['repo:read'] } })).status).toBe(401);
  expect((await api('/tokens', { token: issued.token })).status).toBe(403);
  for (const bad of [{ scopes: ['admin'] }, { scopes: [] }, { expires_days: 91 }, { repos: ['nope'] }])
    expect((await api('/tokens', { cookie }, { body: { name: 'bad', scopes: ['repo:read'], ...bad } })).status).toBe(400);

  expect((await api('/repos', { token: issued.token })).body).toEqual({ repos: [] });
  const revoked = await api(`/tokens/${issued.id}`, { cookie }, { method: 'DELETE' });
  expect(revoked.body).toEqual({ id: issued.id, revoked: true, removed_ssh_keys: [] });
  const refused = await api('/repos', { token: issued.token });
  expect([refused.status, refused.body.error.code]).toEqual([401, 'UNAUTHORIZED']);
  expect((await api(`/tokens/${issued.id}`, { cookie }, { method: 'DELETE' })).status).toBe(404);
  expect((await api('/repos', { token: plain.token })).status).toBe(200);
});

it('holds personal tokens to their scopes, repository allowlist and expiry', async () => {
  const cookie = await signup('pat_scoped');
  const [a, b] = [await repo(cookie, 'alpha'), await repo(cookie, 'beta')];
  const reader = await issue(cookie, { name: 'reader', scopes: ['repo:read'], repos: [a] });
  expect((await api('/repos', { token: reader.token })).body.repos.map((r: any) => r.id)).toEqual([a]);
  expect((await api(`/repos/${a}/tree?path=`, { token: reader.token })).status).toBe(200);
  const outside = await api(`/repos/${b}`, { token: reader.token });
  expect([outside.status, outside.body.error.code]).toEqual([403, 'FORBIDDEN']);
  const main = (await api(`/repos/${a}/refs`, { token: reader.token })).body.refs['refs/heads/main'];
  const write = await api(`/repos/${a}/branches`, { token: reader.token }, { body: { ref: 'x', commit: main, expected: null } });
  expect(write.status).toBe(403);
  expect((await api(`/repos/${a}/tokens`, { token: reader.token })).status).toBe(403);
  expect((await api('/repos', { token: reader.token }, { body: { name: 'gamma' } })).status).toBe(403);

  const writer = await issue(cookie, { name: 'writer', scopes: ['repo:read', 'repo:write'] });
  expect((await api(`/repos/${b}/branches`, { token: writer.token }, { body: { ref: 'x', commit: main, expected: null } })).status).toBe(404);
  const branched = await api(`/repos/${a}/branches`, { token: writer.token }, { body: { ref: 'x', commit: main, expected: null } });
  expect(branched.status).toBe(200);
  const landing = await api(`/repos/${a}/land`, { token: writer.token }, { body: { ref: 'main', commit: main } });
  expect(landing.status).toBe(403);

  // Another account's token reaches none of these repositories.
  const stranger = await issue(await signup('pat_stranger'), { name: 's', scopes: ['repo:admin', 'repo:read'] });
  expect((await api(`/repos/${a}`, { token: stranger.token })).status).toBe(404);
  expect((await api('/repos', { token: stranger.token })).body.repos).toEqual([]);

  // Expired tokens are refused at once (no cache), as is a malformed one.
  await sql('account:pat_scoped', `UPDATE account_tokens SET expires_at=1 WHERE id='${reader.id}'`);
  expect((await api(`/repos/${a}`, { token: reader.token })).status).toBe(401);
  expect((await api('/repos', { token: 'ypat_short' })).status).toBe(401);
  expect((await api('/repos', { token: `ypat_${'A'.repeat(43)}` })).status).toBe(401);
});

it('clones and lists with a personal token, and creates repositories with repo:admin', async () => {
  const cookie = await signup('pat_cloner');
  const id = await repo(cookie, 'cloned');
  const reader = await issue(cookie, { name: 'reader', scopes: ['repo:read'] });
  const access = await api(`/repos/${id}/clone`, { token: reader.token }, { body: {} });
  expect(access.status).toBe(200);
  expect(access.body.remote).toMatch(/^https:\/\/artifacts\.test\//);
  const writer = await issue(cookie, { name: 'writer', scopes: ['repo:write'] });
  expect((await api(`/repos/${id}/clone`, { token: writer.token }, { body: {} })).status).toBe(403);
  expect((await api('/repos', { token: reader.token })).body.repos.map((r: any) => r.name)).toEqual(['cloned']);

  const admin = await issue(cookie, { name: 'cli', scopes: ['repo:admin'] });
  const created = await api('/repos', { token: admin.token }, {
    body: { name: 'from-cli', policy: { required_checks: [], approvals: 0 }, files: [file('a.txt', 'a\n')], author },
  });
  expect(created.status).toBe(200);
  expect((await api('/repos', { cookie })).body.repos.map((r: any) => r.name)).toContain('from-cli');
  // repo:admin is the owner: it lands its own commit under the solo policy it chose.
  const target = `/repos/${created.body.id}`;
  const next = await api(`${target}/commits`, { token: admin.token }, {
    body: { parent: created.body.commit, changes: [file('b.txt', 'b\n')], message: 'b', author },
  });
  expect(next.status).toBe(200);
  const landed = await api(`${target}/land`, { token: admin.token }, { body: { ref: 'main', commit: next.body.commit } });
  expect([landed.status, landed.body.landed]).toEqual([200, true]);
});

async function deviceCode(target: Env = scoped) {
  const body = { client_name: 'yoneda-cli', host: 'ada-mbp' };
  const started = await api('/device/code', {}, { body }, target);
  expect(started.status).toBe(200);
  return started.body;
}
const poll = (device_code: string) => api('/device/token', {}, { body: { device_code } });
const compact = (code: string) => code.replace('-', '');

it('logs a device in: pending, slow down, approved once', async () => {
  const cookie = await signup('device_owner');
  const started = await deviceCode({ ...scoped, WEB_ORIGIN: 'https://dev.example' } as unknown as Env);
  expect(started.user_code).toMatch(/^[BCDFGHJKLMNPQRSTVWXZ]{4}-[BCDFGHJKLMNPQRSTVWXZ]{4}$/);
  expect(started).toMatchObject({
    verification_uri: 'https://dev.example/device',
    verification_uri_complete: `https://dev.example/device?code=${started.user_code}`,
    expires_in: 600,
    interval: 5,
  });
  expect(started.device_code).toEqual(expect.any(String));

  const pending = await poll(started.device_code);
  expect([pending.status, pending.body.error.code]).toEqual([400, 'AUTHORIZATION_PENDING']);
  const slow = await poll(started.device_code);
  expect([slow.status, slow.body.error.code]).toEqual([400, 'SLOW_DOWN']);

  const approval = { user_code: started.user_code.toLowerCase(), scopes: ['repo:read', 'repo:admin'], expires_days: 3 };
  expect((await api('/device/approve', {}, { body: approval })).status).toBe(401);
  const approved = await api('/device/approve', { cookie }, { body: approval });
  expect([approved.status, approved.body]).toEqual([200, { approved: true }]);
  expect((await api('/device/approve', { cookie }, { body: approval })).status).toBe(404);

  await sql(`device:${compact(started.user_code)}`, 'UPDATE device_codes SET last_poll_at=NULL');
  const granted = await poll(started.device_code);
  expect(granted.status).toBe(200);
  expect(granted.body).toMatchObject({ scopes: ['repo:read', 'repo:admin'], repos: null, account: 'device_owner' });
  expect(granted.body.token).toMatch(/^ypat_/);
  expect(granted.body.expires_at - Date.now()).toBeGreaterThan(2 * DAY);
  expect((await api('/repos', { token: granted.body.token })).status).toBe(200);
  // The token says it came from `yoneda login` on that host; a website token does not,
  // and a website caller cannot claim to be a login.
  const listed = (await api('/tokens', { cookie })).body.tokens;
  expect(listed.map((t: any) => [t.name, t.origin, t.host])).toEqual([['yoneda-cli', 'login', 'ada-mbp']]);
  const made = await api('/tokens', { cookie }, { body: { name: 'ci', scopes: ['repo:read'], origin: 'login', host: 'x' } });
  expect([made.status, made.body.origin ?? null, made.body.host ?? null]).toEqual([200, null, null]);
  const both = (await api('/tokens', { cookie })).body.tokens;
  expect(both.map((t: any) => [t.name, t.origin])).toEqual([['yoneda-cli', 'login'], ['ci', null]]);
  await api(`/tokens/${made.body.id}`, { cookie }, { method: 'DELETE' });
  // Single use.
  await sql(`device:${compact(started.user_code)}`, 'UPDATE device_codes SET last_poll_at=NULL');
  const spent = await poll(started.device_code);
  expect([spent.status, spent.body.error.code]).toEqual([400, 'EXPIRED_TOKEN']);
});

it('denies and expires device codes', async () => {
  const cookie = await signup('device_denier');
  const denied = await deviceCode();
  const deny = await api('/device/approve', { cookie }, { body: { user_code: denied.user_code, scopes: ['repo:read'], expires_days: 1, deny: true } });
  expect(deny.body).toEqual({ approved: false });
  expect((await poll(denied.device_code)).body.error.code).toBe('ACCESS_DENIED');
  expect((await poll(denied.device_code)).body.error.code).toBe('EXPIRED_TOKEN');

  const late = await deviceCode();
  await sql(`device:${compact(late.user_code)}`, 'UPDATE device_codes SET expires_at=1');
  expect((await poll(late.device_code)).body.error.code).toBe('EXPIRED_TOKEN');
  const tooLate = await api('/device/approve', { cookie }, { body: { user_code: late.user_code, scopes: ['repo:read'], expires_days: 1 } });
  expect([tooLate.status, tooLate.body.error.code]).toEqual([400, 'EXPIRED_TOKEN']);

  expect((await poll('not-a-device-code')).body.error.code).toBe('EXPIRED_TOKEN');
  expect((await poll(`BCDFGHJK.${'A'.repeat(43)}`)).body.error.code).toBe('EXPIRED_TOKEN');
  expect((await api('/device/approve', { cookie }, { body: { user_code: 'BCDF-GHJK', scopes: ['repo:read'], expires_days: 1 } })).status).toBe(404);
  expect((await api('/device/approve', { cookie }, { body: { user_code: 'AAAA-AAAA', scopes: ['repo:read'], expires_days: 1 } })).status).toBe(400);
  const fresh = await deviceCode();
  const badScopes = await api('/device/approve', { cookie }, { body: { user_code: fresh.user_code, scopes: ['everything'], expires_days: 1 } });
  expect(badScopes.status).toBe(400);
  expect((await api('/device/code', {}, { body: { client_name: '' } })).status).toBe(400);
});
