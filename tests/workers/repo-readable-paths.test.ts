// Readable repository paths through the Workers: `/<handle>/<name>` resolves (any case, an
// earlier name too), Git clones by path on both hosts, `/source/<id>` pages move there for
// readers, names are unique per owner ignoring case, a rename keeps the old name working,
// profiles list public repositories, an email-named account picks a handle (never shown
// its address), reserved names are refused, and a private repository answers exactly as
// a missing one to everyone who may not read it.
import { expect, it } from 'vitest';
import { encodeAccountIdentifier } from '../../shared/account';
import { frontFetch } from '../../cloudflare/worker/front-routes';
import { platformFetch } from '../../cloudflare/worker/platform-routes';
import { sha } from '../../cloudflare/worker/storage';
import type { Env } from '../../cloudflare/worker/types';
import { workspace } from '../../cloudflare/worker/workspace';
import { api, author, bindings, file, scoped, signup, usePlatformFixture } from './repo-fixture';

usePlatformFixture();

// The app's pages (static assets) answer as the app.
const app = { fetch: async () => new Response('<!doctype html>app', { headers: { 'content-type': 'text/html' } }) };
const local = { ...scoped, PLATFORM_OBJECT_STORE: 'r2', ASSETS: app } as unknown as Env;
const pkt = (line: string) => `${(line.length + 4).toString(16).padStart(4, '0')}${line}`;
const fetchCommand = (args: string[]) =>
  `${pkt('command=fetch\n')}${pkt('object-format=sha1\n')}0001${args.map((a) => pkt(`${a}\n`)).join('')}0000`;

async function create(cookie: string, name: string, extra: Record<string, unknown> = {}) {
  return api('/repos', { cookie }, {
    body: { name, policy: { required_checks: [], approvals: 0 }, files: [file('a.txt', 'a\n')], author, ...extra },
  }, local);
}

/** Git's v2 fetch of `want` at `path` (`/git/<id>.git` or `/<handle>/<name>.git`). */
async function clone(path: string, want: string, auth?: string) {
  const response = await platformFetch(
    new Request(`https://yoneda${path}/git-upload-pack`, {
      method: 'POST',
      headers: { 'git-protocol': 'version=2', ...(auth ? { authorization: auth } : {}) },
      body: fetchCommand([`want ${want}`, 'done']),
    }),
    local,
  );
  return { status: response.status, text: new TextDecoder().decode(await response.arrayBuffer()) };
}

it('resolves, clones and redirects by readable path, unique per owner, and keeps an old name after a rename', async () => {
  const cookie = await signup('ada');
  const made = await create(cookie, 'Testing');
  expect(made.status).toBe(200);
  const id = made.body.id as string;
  const commit = made.body.commit as string;

  // Any case, and Git's `.git`, name it.
  for (const asked of ['Testing', 'testing', 'TESTING.git']) {
    const resolved = await api(`/resolve/ada/${asked}`, { cookie }, {}, local);
    expect([resolved.status, resolved.body], asked).toEqual([200, { id, handle: 'ada', name: 'Testing', path: '/ada/Testing' }]);
  }
  expect((await api(`/repos/${id}`, { cookie }, {}, local)).body).toMatchObject({ owner_handle: 'ada', path: '/ada/Testing' });
  expect((await api('/repos', { cookie }, {}, local)).body.repos[0]).toMatchObject({ id, owner_handle: 'ada', path: '/ada/Testing' });
  // One name per owner, ignoring case; another owner may use it.
  const taken = await create(cookie, 'TESTING');
  expect([taken.status, taken.body.error?.code]).toEqual([409, 'NAME_TAKEN']);
  expect((await create(await signup('grace'), 'testing')).status).toBe(200);

  // Git by path is Git by id.
  const token = (await api(`/repos/${id}/tokens`, { cookie }, { body: { name: 'reader', scopes: ['read'] } }, local)).body.token;
  const basic = `Basic ${btoa(`git:${token}`)}`;
  for (const path of [`/git/${id}.git`, '/ada/Testing.git', '/ada/testing']) {
    const cloned = await clone(path, commit, basic);
    expect([cloned.status, cloned.text.includes('packfile'), cloned.text.includes('ERR')], path).toEqual([200, true, false]);
  }
  // The front Worker passes Git paths to the platform.
  const front = { ...local, PLATFORM: { fetch: (req: Request) => platformFetch(req, local) } } as unknown as Env;
  const refs = await frontFetch(
    new Request('https://yoneda/ada/Testing.git/info/refs?service=git-upload-pack', { headers: { authorization: basic, 'git-protocol': 'version=2' } }),
    front,
  );
  expect([refs.status, await refs.text()]).toEqual([200, expect.stringContaining('version 2')]);

  // An old page address moves to the readable one, its subpath and query kept.
  const page = (path: string, who: string | null, env: Env = local) =>
    (env === local ? platformFetch : frontFetch)(
      new Request(`https://yoneda${path}`, { headers: who ? { cookie: who } : {} }),
      env,
    );
  const moved = await page(`/source/${id}/changes/12?tab=files`, cookie);
  expect([moved.status, moved.headers.get('location')]).toEqual([301, '/ada/Testing/changes/12?tab=files']);
  expect((await page(`/source/${id}`, cookie, front)).headers.get('location')).toBe('/ada/Testing');

  // A rename: the new name resolves, the old one answers it (and clones), the old name is
  // not free while it still names this repository's history... until another takes it.
  const renamed = await api(`/repos/${id}/name`, { cookie }, { method: 'PUT', body: { name: 'renamed' } }, local);
  expect([renamed.status, renamed.body]).toEqual([200, { name: 'renamed', previous: 'Testing', path: '/ada/renamed' }]);
  expect((await api(`/resolve/ada/testing`, { cookie }, {}, local)).body).toEqual({
    id, handle: 'ada', name: 'renamed', path: '/ada/renamed', renamed_from: 'Testing',
  });
  expect((await clone('/ada/Testing.git', commit, basic)).text).toContain('packfile');
  expect((await page(`/source/${id}`, cookie)).headers.get('location')).toBe('/ada/renamed');
  const other = await create(cookie, 'other');
  const clash = await api(`/repos/${other.body.id}/name`, { cookie }, { method: 'PUT', body: { name: 'Renamed' } }, local);
  expect([clash.status, clash.body.error?.code]).toEqual([409, 'NAME_TAKEN']);
  expect((await api(`/repos/${other.body.id}/name`, { cookie }, { method: 'PUT', body: { name: 'Testing' } }, local)).status).toBe(200);
  expect((await api(`/resolve/ada/testing`, { cookie }, {}, local)).body.id).toBe(other.body.id);
  // A deleted repository frees its names.
  expect((await api(`/repos/${other.body.id}?confirm=Testing`, { cookie }, { method: 'DELETE' }, local)).status).toBe(200);
  expect((await api(`/resolve/ada/testing`, { cookie }, {}, local)).status).toBe(404);
});

it('answers a private repository exactly as a missing one to anyone who may not read it', async () => {
  const cookie = await signup('owner_p');
  const made = await create(cookie, 'secret');
  const id = made.body.id as string;
  const outsider = await signup('outsider');
  const outsiderToken = (await api('/tokens', { cookie: outsider }, { body: { name: 'pat', scopes: ['repo:read'], expires_days: 30 } }, local)).body.token;
  const asks: [string, string | undefined][] = [['nobody', undefined], ['outsider', outsider]];
  for (const [who, auth] of asks) {
    const hidden = await api('/resolve/owner_p/secret', { cookie: auth }, {}, local);
    const none = await api('/resolve/owner_p/nothing', { cookie: auth }, {}, local);
    const nobody = await api('/resolve/no_such_handle/secret', { cookie: auth }, {}, local);
    expect([hidden.status, hidden.body], who).toEqual([none.status, none.body]);
    expect([nobody.status, nobody.body], who).toEqual([none.status, none.body]);
    expect(none.status, who).toBe(404);
    const path = await api(`/repos/${id}/path`, { cookie: auth }, {}, local);
    expect([path.status, path.body.error?.code], who).toEqual([404, 'NOT_FOUND']);
    // An old address is served to them as before (the app), never moved.
    const page = await platformFetch(new Request(`https://yoneda/source/${id}`, { headers: auth ? { cookie: auth } : {} }), local);
    expect(page.status, who).not.toBe(301);
  }
  // Git by path, with no credentials and with an outsider's: as for a missing repository.
  const commit = made.body.commit as string;
  for (const auth of [undefined, `Basic ${btoa(`git:${outsiderToken}`)}`]) {
    const hidden = await clone('/owner_p/secret.git', commit, auth);
    const missing = await clone('/owner_p/nothing.git', commit, auth);
    expect(hidden).toEqual(missing);
    expect(hidden.status).not.toBe(200);
  }
  // Made public, everyone reads it by path.
  expect((await api(`/repos/${id}/visibility`, { cookie }, { method: 'PUT', body: { visibility: 'public' } }, local)).status).toBe(200);
  expect((await api('/resolve/owner_p/secret', {}, {}, local)).body).toMatchObject({ id, path: '/owner_p/secret' });
  const profile = await api('/profiles/owner_p', {}, {}, local);
  expect([profile.status, profile.body]).toEqual([
    200,
    { handle: 'owner_p', kind: 'user', display_name: null, repositories: [expect.objectContaining({ id, name: 'secret', path: '/owner_p/secret' })] },
  ]);
  for (const handle of ['docs', 'no_such_handle', 'owner_p@example.com'])
    expect((await api(`/profiles/${encodeURIComponent(handle)}`, {}, {}, local)).status, handle).toBe(404);
});

it('lets an account named by its address pick a handle, which then names it everywhere', async () => {
  // An account made before sign-up named accounts by handle: named by its address.
  const email = 'grace.hopper@example.com';
  const token = 'f'.repeat(64);
  await workspace(bindings, email, {
    op: 'signup',
    username: email,
    password: 'long platform test password',
    salt: '01'.repeat(16),
    session_hash: await sha(token),
    recovery_hash: 'b'.repeat(64),
  });
  const cookie = `yoneda_account=${encodeAccountIdentifier(email)}.${token}`;
  const session = async () => (await platformFetch(new Request('https://yoneda/api/auth/session', { headers: { cookie } }), local)).json<any>();
  expect(await session()).toMatchObject({ authenticated: true, handle: null });
  const made = await create(cookie, 'compiler', { visibility: 'public' });
  expect(made.status).toBe(200);
  // No handle yet: no readable path, and the public listing never shows the address.
  expect((await api(`/repos/${made.body.id}`, { cookie }, {}, local)).body).toMatchObject({ owner_handle: null, path: null });
  const listed = async () => (await api('/explore', {}, {}, local)).body.repos.find((r: any) => r.id === made.body.id);
  expect(JSON.stringify(await listed())).not.toContain('@');

  const pick = (handle: string) =>
    platformFetch(
      new Request('https://yoneda/api/auth/handle', { method: 'PUT', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ handle }) }),
      local,
    ).then(async (r) => ({ status: r.status, body: await r.json<any>() }));
  await signup('taken_name');
  expect((await pick('docs')).body.error.code).toBe('HANDLE_RESERVED');
  expect((await pick('x')).body.error.code).toBe('HANDLE_INVALID');
  expect([(await pick('taken_name')).status, (await pick('taken_name')).body.error.code]).toEqual([409, 'HANDLE_TAKEN']);
  expect(await pick('Grace')).toEqual({ status: 200, body: { handle: 'grace' } });
  expect(await session()).toMatchObject({ handle: 'grace' });
  expect(await listed()).toMatchObject({ owner: 'grace', owner_handle: 'grace', path: '/grace/compiler' });
  expect((await api('/resolve/grace/compiler', {}, {}, local)).body).toMatchObject({ id: made.body.id, path: '/grace/compiler' });
  expect((await api('/profiles/grace', {}, {}, local)).body).toMatchObject({ handle: 'grace', kind: 'user' });
  // Nobody signs up as it now; a person named by a handle cannot pick another.
  const clash = await bindings.SELF.fetch('https://yoneda/api/auth/signup', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'grace@example.com', password: 'long platform test password' }),
  });
  expect((await clash.json<any>()).username).not.toBe('grace');
  const ada = await signup('ada_fixed');
  const fixed = await platformFetch(
    new Request('https://yoneda/api/auth/handle', { method: 'PUT', headers: { cookie: ada, 'content-type': 'application/json' }, body: JSON.stringify({ handle: 'other_name' }) }),
    local,
  );
  expect([fixed.status, (await fixed.json<any>()).error.code]).toEqual([409, 'HANDLE_FIXED']);
  // A second pick moves the handle; the first is free again.
  expect((await pick('hopper')).status).toBe(200);
  expect((await api('/profiles/grace', {}, {}, local)).status).toBe(404);
  expect((await api('/resolve/hopper/compiler', {}, {}, local)).body.path).toBe('/hopper/compiler');
});
