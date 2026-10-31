// Favorite repositories through the public API: a signed-in person's only (anonymous callers,
// personal tokens and repository tokens are refused), saved on the account, idempotent, at
// most 50, and never a way to see a repository the account cannot read: refused alike for a
// private and a missing one, and dropped from the list once deleted or out of reach.
import { expect, it } from 'vitest';
import { api, author, bindings, file, signup, usePlatformFixture } from './repo-fixture';

usePlatformFixture();

const MISSING = `r${'0'.repeat(20)}`;
const seeded = (name: string) => ({ name, files: [file('README.md', `# ${name}\n`)], author });

async function repo(cookie: string, name: string, extra: object = {}) {
  const created = await api('/repos', { cookie }, { body: { ...seeded(name), ...extra } });
  expect(created.status, JSON.stringify(created.body)).toBe(200);
  return created.body.id as string;
}
const favorite = (cookie: string, id: string, method = 'PUT') =>
  api(`/favorites/${id}`, { cookie }, { method });
const listed = async (cookie: string) => {
  const answer = await api('/favorites', { cookie });
  expect(answer.status, JSON.stringify(answer.body)).toBe(200);
  return answer.body.favorites as any[];
};

it('saves a favorite on the account, named by the listing, and adding it again changes nothing', async () => {
  const cookie = await signup('fav_owner');
  const id = await repo(cookie, 'parser');
  expect(await listed(cookie)).toEqual([]);
  expect((await favorite(cookie, id)).status).toBe(200);
  expect((await favorite(cookie, id)).status).toBe(200);
  expect(await listed(cookie)).toEqual([
    expect.objectContaining({ id, name: 'parser', owner_handle: 'fav_owner', visibility: 'private' }),
  ]);
  // A new session of the same account sees it: the account holds it, not the browser.
  const login = await bindings.SELF.fetch('https://yoneda/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'fav_owner', password: 'long platform test password' }),
  });
  const second = (login.headers.get('set-cookie') ?? '').split(';')[0];
  expect((await listed(second)).map((f) => f.id)).toEqual([id]);

  expect((await favorite(cookie, id, 'DELETE')).status).toBe(200);
  expect((await favorite(cookie, id, 'DELETE')).status).toBe(200);
  expect(await listed(cookie)).toEqual([]);
});

it('answers only a signed-in person', async () => {
  const cookie = await signup('fav_tokens');
  const id = await repo(cookie, 'mine');
  await favorite(cookie, id);
  expect((await api('/favorites', {})).status).toBe(401);
  expect((await api(`/favorites/${id}`, {}, { method: 'PUT' })).status).toBe(401);
  expect((await api(`/favorites/${id}`, {}, { method: 'DELETE' })).status).toBe(401);

  const pat = await api(
    '/tokens',
    { cookie },
    { body: { name: 'ci', scopes: ['repo:read', 'repo:write', 'repo:admin'] } },
  );
  const repoToken = await api(`/repos/${id}/tokens`, { cookie }, { body: { name: 'bot', scopes: ['read'] } });
  for (const token of [pat.body.token, repoToken.body.token]) {
    expect(token).toBeTruthy();
    expect((await api('/favorites', { token })).status).toBe(401);
    expect((await api(`/favorites/${id}`, { token }, { method: 'PUT' })).status).toBe(401);
    expect((await api(`/favorites/${id}`, { token }, { method: 'DELETE' })).status).toBe(401);
  }
  expect((await listed(cookie)).map((f) => f.id)).toEqual([id]);
  expect((await api('/favorites', { cookie }, { method: 'POST', body: {} })).status).toBe(404);
  expect((await api('/favorites/parser', { cookie }, { method: 'PUT' })).status).toBe(404);
});

it("refuses a private repository as if it were missing, and takes anyone's public one", async () => {
  const owner = await signup('fav_private');
  const stranger = await signup('fav_stranger');
  const secret = await repo(owner, 'secret');
  const open = await repo(owner, 'open', { visibility: 'public' });

  const refused = await favorite(stranger, secret);
  const missing = await favorite(stranger, MISSING);
  expect(refused.status).toBe(404);
  expect(refused.body).toEqual(missing.body);
  expect(await listed(stranger)).toEqual([]);

  expect((await favorite(stranger, open)).status).toBe(200);
  const [listing] = await listed(stranger);
  expect(listing).toMatchObject({ id: open, name: 'open', owner_handle: 'fav_private', visibility: 'public' });
  expect(JSON.stringify(listing)).not.toContain('@');
});

it('drops a favorite that went out of reach, and shows it again when access returns', async () => {
  const owner = await signup('fav_lender');
  const bob = await signup('fav_bob');
  const shared = await repo(owner, 'shared');
  const invited = await api(`/repos/${shared}/members`, { cookie: owner }, { body: { account: 'fav_bob', role: 'read' } });
  expect(invited.status).toBe(200);
  await favorite(bob, shared);
  expect((await listed(bob)).map((f) => f.id)).toEqual([shared]);

  const removed = await api(`/repos/${shared}/members/fav_bob`, { cookie: owner }, { method: 'DELETE' });
  expect(removed.status).toBe(200);
  expect(await listed(bob)).toEqual([]);

  await api(`/repos/${shared}/members`, { cookie: owner }, { body: { account: 'fav_bob', role: 'read' } });
  expect((await listed(bob)).map((f) => f.id)).toEqual([shared]);
});

it('drops a deleted repository, and a public one that turned private', async () => {
  const owner = await signup('fav_deleter');
  const fan = await signup('fav_fan');
  const doomed = await repo(owner, 'doomed');
  const open = await repo(owner, 'closing', { visibility: 'public' });
  await favorite(owner, doomed);
  await favorite(fan, open);

  const deleted = await api(`/repos/${doomed}?confirm=doomed`, { cookie: owner }, { method: 'DELETE' });
  expect(deleted.status).toBe(200);
  expect(await listed(owner)).toEqual([]);

  const closed = await api(`/repos/${open}/visibility`, { cookie: owner }, { method: 'PUT', body: { visibility: 'private' } });
  expect(closed.status, JSON.stringify(closed.body)).toBe(200);
  expect(await listed(fan)).toEqual([]);
});

it('keeps 50, passes a repeat at the limit, and makes room from favorites out of reach', async () => {
  const cookie = await signup('fav_many');
  // Straight in the index: 51 real repositories would only slow this down.
  const ids = Array.from({ length: 51 }, (_, n) => `r${(n + 1).toString(16).padStart(20, 'a')}`);
  for (const [n, id] of ids.entries())
    await bindings.INDEX.prepare(
      'INSERT INTO platform_repos(id,workspace,name,created_at,visibility) VALUES(?,?,?,?,?)',
    )
      .bind(id, 'fav_many', `repo-${n}`, n, 'private')
      .run();
  const [first, ...rest] = ids as [string, ...string[]];
  const last = rest.pop() as string;
  for (const id of [first, ...rest]) expect((await favorite(cookie, id)).status).toBe(200);

  const full = await favorite(cookie, last);
  expect(full.status).toBe(409);
  expect(full.body.error.code).toBe('FAVORITES_FULL');
  expect((await favorite(cookie, first)).status).toBe(200);
  expect(await listed(cookie)).toHaveLength(50);

  // A deleted repository no longer holds a place the account cannot see.
  await bindings.INDEX.prepare('DELETE FROM platform_repos WHERE id=?').bind(first).run();
  expect(await listed(cookie)).toHaveLength(49);
  expect((await favorite(cookie, last)).status).toBe(200);
  expect((await listed(cookie)).map((f) => f.id)).toContain(last);
});
