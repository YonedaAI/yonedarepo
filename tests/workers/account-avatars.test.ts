// Account pictures (workerd): the provider's picture from sign-in, served as a redirect to
// its allow-listed host (never fetched); an uploaded PNG, JPEG or WebP (at most 1 MiB,
// typed by its bytes) stored in R2 and served from our origin with nosniff; removal falling
// back to the provider's, then to none; email-named accounts never served publicly.
import { expect, it } from 'vitest';
import { platformFetch } from '../../cloudflare/worker/platform-routes';
import { workspace } from '../../cloudflare/worker/workspace';
import { bindings, scoped, signup, usePlatformFixture } from './repo-fixture';

usePlatformFixture();

const GITHUB = 'https://avatars.githubusercontent.com/u/583231?v=4';
const PNG = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d, 0x49, 0x48, 0x44, 0x52, 1, 2, 3,
]);
const GIF = new TextEncoder().encode('GIF89a\x01\x00\x01\x00\x00\x00\x00\x00\x00\x00\x00');

const fetchApi = (path: string, init: RequestInit & { cookie?: string } = {}) => {
  const headers = new Headers(init.headers);
  if (init.cookie) headers.set('cookie', init.cookie);
  return platformFetch(
    new Request(`https://yoneda/api/v1${path}`, { ...init, headers, redirect: 'manual' }),
    scoped,
  );
};
const upload = (cookie: string, body: BodyInit) =>
  fetchApi('/account/avatar', { method: 'PUT', cookie, body });
const session = async (cookie: string) =>
  (
    await bindings.SELF.fetch('https://yoneda/api/auth/session', { headers: { cookie } })
  ).json<{ username: string; avatar_url: string | null }>();

/** An account made by a GitHub sign-in that reported `avatar` as its picture. */
async function githubAccount(name: string, avatar: string) {
  await workspace(bindings, name, {
    op: 'identity_signup',
    username: name,
    session_hash: 'a'.repeat(64),
    provider: 'github',
    subject: '583231',
    login: name,
    email: null,
    avatar_url: avatar,
  });
}

it("serves the provider's picture as a redirect to its own host, and nothing for other hosts", async () => {
  await githubAccount('octo_cat', GITHUB);
  const served = await fetchApi('/avatars/octo_cat');
  expect(served.status).toBe(302);
  expect(served.headers.get('location')).toBe(GITHUB);
  expect(served.headers.get('cache-control')).toMatch(/max-age=\d+/);

  await githubAccount('evil_host', 'https://evil.example/u/1.png');
  expect((await fetchApi('/avatars/evil_host')).status).toBe(404);
  // No account, a malformed name and an email-named account answer alike.
  for (const name of ['nobody_here', 'Bad..Name', encodeURIComponent('someone@example.com')])
    expect((await fetchApi(`/avatars/${name}`)).status, name).toBe(404);
});

it('stores an uploaded picture in R2, serves it with nosniff, and falls back on removal', async () => {
  const cookie = await signup('pic_owner');
  expect((await session(cookie)).avatar_url).toBeNull();

  const stored = await upload(cookie, PNG);
  expect(stored.status, await stored.clone().text()).toBe(200);
  const { avatar_url } = await stored.json<{ avatar_url: string }>();
  expect(avatar_url).toMatch(/^\/api\/v1\/account\/avatar\?v=[0-9a-f]{12}$/);
  expect((await session(cookie)).avatar_url).toBe(avatar_url);

  const served = await fetchApi('/avatars/pic_owner');
  expect(served.status).toBe(200);
  expect(served.headers.get('content-type')).toBe('image/png');
  expect(served.headers.get('x-content-type-options')).toBe('nosniff');
  expect(served.headers.get('content-security-policy')).toContain("default-src 'none'");
  expect(new Uint8Array(await served.arrayBuffer())).toEqual(PNG);
  const own = await fetchApi('/account/avatar', { cookie });
  expect(own.status).toBe(200);
  expect(own.headers.get('cache-control')).toMatch(/^private/);
  await own.arrayBuffer();

  // A second upload replaces the first and deletes its bytes.
  const listed = async () => (await bindings.OBJECTS.list({ prefix: 'avatars/' })).objects.length;
  expect(await listed()).toBe(1);
  const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, ...new Array(40).fill(7)]);
  expect((await upload(cookie, jpeg)).status).toBe(200);
  expect(await listed()).toBe(1);
  expect((await fetchApi('/avatars/pic_owner')).headers.get('content-type')).toBe('image/jpeg');

  // Removal deletes the bytes; with no provider picture there is none.
  const removed = await fetchApi('/account/avatar', { method: 'DELETE', cookie });
  expect(removed.status).toBe(200);
  expect(await removed.json()).toEqual({ avatar_url: null });
  expect(await listed()).toBe(0);
  expect((await fetchApi('/avatars/pic_owner')).status).toBe(404);
});

it('refuses other types, oversize pictures and callers without a signed-in session', async () => {
  const cookie = await signup('pic_guard');
  for (const [body, status] of [
    [GIF, 400],
    [new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"></svg>'), 400],
    [new Uint8Array(0), 400],
    [new Uint8Array(1024 * 1024 + 1).fill(0x89), 413],
  ] as const) {
    const refused = await upload(cookie, body);
    expect(refused.status, String(body.byteLength)).toBe(status);
  }
  expect((await bindings.OBJECTS.list({ prefix: 'avatars/' })).objects).toHaveLength(0);
  expect((await upload('', PNG)).status).toBe(401);
  expect((await fetchApi('/account/avatar', { method: 'DELETE' })).status).toBe(401);
});

it("an upload wins over the provider's picture, and removing it brings that back", async () => {
  await githubAccount('both_pics', GITHUB);
  // Sign the account in (an identity sign-in) to get a session cookie for it.
  await workspace(bindings, 'both_pics', {
    op: 'identity_signin',
    provider: 'github',
    subject: '583231',
    session_hash: await sha('b'.repeat(64)),
    avatar_url: GITHUB,
  });
  const cookie = `yoneda_account=both_pics.${'b'.repeat(64)}`;
  expect((await session(cookie)).avatar_url).toMatch(/^\/api\/v1\/account\/avatar\?v=/);
  expect((await upload(cookie, PNG)).status).toBe(200);
  expect((await fetchApi('/avatars/both_pics')).status).toBe(200);
  await fetchApi('/account/avatar', { method: 'DELETE', cookie });
  expect((await fetchApi('/avatars/both_pics')).headers.get('location')).toBe(GITHUB);
});

async function sha(text: string) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
