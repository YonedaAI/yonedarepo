import { expect, it } from 'vitest';
import { imageAnswer } from '../../cloudflare/worker/repo-image-response';
import { platformFetch } from '../../cloudflare/worker/platform-routes';
import type { Env } from '../../cloudflare/worker/types';
import { api, author, drainObjects, file, scoped, signup, usePlatformFixture } from './repo-fixture';

usePlatformFixture();
const on = { ...scoped, REPO_IMAGE_REVALIDATION: 'on' } as Env;
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/P4sAAAAASUVORK5CYII=';
async function setup(name: string) {
  const owner = { cookie: await signup(name) };
  const created = await api('/repos', owner, { body: {
    name: 'image-fixture', author, policy: { approvals: 0, required_checks: [] },
    files: [{ path: 'assets/picture.png', content_b64: png }, file('README.md', '# Image fixture\n')],
    tokens: [{ name: 'reader', scopes: ['read'] }],
  } }, on);
  expect(created.status).toBe(200);
  await drainObjects(on);
  return { owner, id: created.body.id, reader: { token: created.body.tokens[0].token } };
}
function read(id: string, auth: { cookie?: string; token?: string }, etag?: string, env = on, suffix = 'assets/picture.png&revalidate=image') {
  const headers = new Headers();
  if (auth.cookie) headers.set('cookie', auth.cookie);
  if (auth.token) headers.set('authorization', `Bearer ${auth.token}`);
  if (etag) headers.set('if-none-match', etag);
  return platformFetch(new Request(`https://yoneda/api/v1/repos/${id}/blob?path=${suffix}`, { headers }), env);
}

it('revalidates an unchanged admitted image with a bodyless private response', async () => {
  const r = await setup('image_cache_hit');
  const first = await read(r.id, r.owner);
  expect(first.status).toBe(200);
  const tag = first.headers.get('etag');
  expect(tag).toMatch(/^W\/"image-v1-[a-f0-9]{64}"$/);
  expect(first.headers.get('cache-control')).toBe('private, no-cache, must-revalidate');
  expect(first.headers.get('vary')).toBe('Cookie, Authorization');
  expect((await first.json<any>()).content).toBe(png);
  const second = await read(r.id, r.owner, tag!);
  expect(second.status).toBe(304);
  expect(second.body).toBeNull();
  expect(second.headers.get('etag')).toBe(tag);
  expect(second.headers.get('cache-control')).toBe('private, no-cache, must-revalidate');
  expect(second.headers.get('vary')).toBe('Cookie, Authorization');
});

it('never returns a cached success to a stranger, invalid token or revoked token', async () => {
  const r = await setup('image_cache_access');
  const first = await read(r.id, r.reader);
  const tag = first.headers.get('etag')!;
  const stranger = { cookie: await signup('image_cache_stranger') };
  for (const auth of [stranger, { token: 'yrp_invalid' }]) {
    const denied = await read(r.id, auth, tag);
    expect(denied.status).not.toBe(304);
    expect(denied.ok).toBe(false);
    expect(denied.headers.get('cache-control')).toBe('no-store');
  }
  expect((await api(`/repos/${r.id}/tokens/reader`, r.owner, { method: 'DELETE' }, on)).status).toBe(200);
  const denied = await read(r.id, r.reader, tag);
  expect(denied.ok).toBe(false);
  expect(denied.status).not.toBe(304);
});

it('checks quarantine and path grants before considering the conditional header', async () => {
  const r = await setup('image_cache_quarantine');
  const first = await read(r.id, r.owner);
  const tag = first.headers.get('etag')!;
  const restricted = await api(`/repos/${r.id}/tokens`, r.owner, { body: { name: 'restricted', scopes: ['read'], paths: ['docs/'] } }, on);
  const denied = await read(r.id, { token: restricted.body.token }, tag);
  expect(denied.ok).toBe(false);
  expect(denied.status).not.toBe(304);
  expect((await api(`/repos/${r.id}/quarantine`, r.owner, { body: { path: 'assets/picture.png', reason: 'Fixture quarantine' } }, on)).status).toBe(200);
  const withheld = await read(r.id, r.owner, tag);
  expect(withheld.status).toBe(451);
  expect(withheld.headers.get('cache-control')).toBe('no-store');
});

it('keeps off, ordinary blob, text and missing responses on no-store', async () => {
  const r = await setup('image_cache_off');
  for (const [env, suffix] of [
    [{ ...on, REPO_IMAGE_REVALIDATION: 'off' } as Env, 'assets/picture.png&revalidate=image'],
    [on, 'assets/picture.png'], [on, 'README.md&revalidate=image'], [on, 'missing.png&revalidate=image'],
  ] as const) {
    const response = await read(r.id, r.owner, '*', env, suffix);
    expect(response.status).not.toBe(304);
    expect(response.headers.get('etag')).toBeNull();
    expect(response.headers.get('cache-control')).toBe('no-store');
  }
});

it('replaces a cached body when the selected branch image changes', async () => {
  const r = await setup('image_cache_change');
  const first = await read(r.id, r.owner);
  const tag = first.headers.get('etag')!;
  const gif = 'R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=';
  const next = await api(`/repos/${r.id}/commits`, r.owner, { body: {
    ref: 'main', changes: [{ path: 'assets/picture.png', content_b64: gif }], message: 'Replace image', author,
  } }, on);
  expect(next.status).toBe(200);
  expect((await api(`/repos/${r.id}/land`, r.owner, { body: { ref: 'main', commit: next.body.commit } }, on)).status).toBe(200);
  const changed = await read(r.id, r.owner, tag);
  expect(changed.status).toBe(200);
  expect(changed.headers.get('etag')).not.toBe(tag);
  expect((await changed.json<any>()).content).toBe(gif);
});

it('terminates conditional headers before JSON-only regional hops and preserves credentials', async () => {
  const original = new Request('https://yoneda/api/v1/repos/r0123456789abcdef0123/blob?revalidate=image', {
    headers: { cookie: 'fixture=private', authorization: 'Bearer fixture', 'if-none-match': '*' },
  });
  const result = await imageAnswer(original, async (forwarded) => {
    expect(forwarded.headers.get('if-none-match')).toBeNull();
    expect(forwarded.headers.get('cookie')).toBe('fixture=private');
    expect(forwarded.headers.get('authorization')).toBe('Bearer fixture');
    return { encoding: 'base64', content: png, size: 68 };
  });
  expect(result.status).toBe(304);
  expect(original.headers.get('if-none-match')).toBe('*');
});

it('does not cache oversized, malformed or non-raster binary data', async () => {
  for (const value of [
    { encoding: 'base64', content: png, size: 8 * 1024 * 1024 + 1 },
    { encoding: 'base64', content: 'not base64?', size: 10 },
    { encoding: 'base64', content: btoa('<svg></svg>'), size: 11 },
  ]) {
    const result = await imageAnswer(new Request('https://yoneda', { headers: { 'if-none-match': '*' } }), async () => value);
    expect(result.status).toBe(200);
    expect(result.headers.get('cache-control')).toBe('no-store');
    expect(result.headers.get('etag')).toBeNull();
  }
});
