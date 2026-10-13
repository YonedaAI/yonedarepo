import { env } from 'cloudflare:test';
import { expect, it } from 'vitest';
import { sha } from '../../cloudflare/apps/bundle';
import type { AppsEnv } from '../../cloudflare/apps/host';
import { serveApp } from '../../cloudflare/apps/host';
import { install } from './apps-test-fixture';

let sequence = 0;
const token = 'test-signed-capability';
async function fixture() {
  const id = `host:approved-${sequence++}`;
  const app = await install('host');
  const previewOrigin = `https://preview-${(await sha(id)).slice(0, 24)}.example.com`;
  let calls = 0;
  const bindings = {
    ...env,
    APP_DOMAIN: 'example.com',
    APP_ORIGIN: 'https://apps.example.com',
    PLATFORM_ORIGIN: 'https://example.com',
    PLATFORM: {
      async authorizeAppPreview(value: string, cap: string) {
        calls++;
        return value === id && cap === token ? app : null;
      },
      async publishedApp() {
        return null;
      },
    },
  } as unknown as AppsEnv;
  const gateway = `https://apps.example.com/v/${encodeURIComponent(id)}/${token}`;
  return { id, app, bindings, previewOrigin, gateway, calls: () => calls };
}
it('gateway redirects to per-preview host then exchanges capability cookie and serves root API', async () => {
  const f = await fixture();
  const redirect = await serveApp(new Request(f.gateway), f.bindings);
  expect(redirect.status).toBe(307);
  expect(redirect.headers.get('location')).toBe(
    `${f.previewOrigin}/v/${encodeURIComponent(f.id)}/${token}`,
  );
  const exchange = await serveApp(new Request(redirect.headers.get('location') ?? ''), f.bindings);
  expect(exchange.headers.get('location')).toBe(`${f.previewOrigin}/`);
  const cookie = exchange.headers.get('set-cookie') ?? '';
  expect(cookie).toContain('__Host-yoneda-app-preview=');
  expect(cookie).toContain('HttpOnly');
  expect(cookie).toContain('Secure');
  expect(cookie).not.toContain('Domain=');
  const res = await serveApp(
    new Request(`${f.previewOrigin}/api/notes`, { headers: { cookie } }),
    f.bindings,
  );
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ tag: 'v1', values: ['seed'] });
  expect(res.headers.get('set-cookie')).toBeNull();
  expect(res.headers.get('content-security-policy')).toContain("connect-src 'self'");
});
it('denies wrong hosts, revoked tokens, gateway API, and cross-origin writes', async () => {
  const f = await fixture();
  const exchange = await serveApp(
    new Request(`${f.previewOrigin}/v/${encodeURIComponent(f.id)}/${token}`),
    f.bindings,
  );
  const cookie = exchange.headers.get('set-cookie') ?? '';
  expect(
    (
      await serveApp(
        new Request(`https://preview-${'0'.repeat(24)}.example.com/api/notes`, {
          headers: { cookie },
        }),
        f.bindings,
      )
    ).status,
  ).toBe(404);
  expect(
    (
      await serveApp(
        new Request('https://apps.example.com/api/notes', { headers: { cookie } }),
        f.bindings,
      )
    ).status,
  ).toBe(404);
  expect(
    (
      await serveApp(
        new Request(`${f.previewOrigin}/api/notes`, {
          method: 'POST',
          body: 'bad',
          headers: { cookie, origin: 'https://elsewhere.example.com' },
        }),
        f.bindings,
      )
    ).status,
  ).toBe(403);
  expect(
    (
      await serveApp(
        new Request(`${f.previewOrigin}/api/notes`, {
          method: 'POST',
          body: 'ok',
          headers: { cookie, origin: f.previewOrigin },
        }),
        f.bindings,
      )
    ).status,
  ).toBe(200);
  f.bindings.PLATFORM.authorizeAppPreview = async () => null;
  expect(
    (
      await serveApp(
        new Request(`${f.previewOrigin}/api/notes`, { headers: { cookie } }),
        f.bindings,
      )
    ).status,
  ).toBe(404);
});
it('separates same-bundle candidates and published root origins and strips platform credentials', async () => {
  const f = await fixture();
  const second = 'host:second';
  const secondOrigin = `https://preview-${(await sha(second)).slice(0, 24)}.example.com`;
  f.bindings.PLATFORM.authorizeAppPreview = async (value, cap) =>
    [f.id, second].includes(value) && cap === token ? f.app : null;
  const cookies: Record<string, string> = {};
  for (const [key, origin] of [
    [f.id, f.previewOrigin],
    [second, secondOrigin],
  ]) {
    const res = await serveApp(
      new Request(`${origin}/v/${encodeURIComponent(key)}/${token}`),
      f.bindings,
    );
    cookies[key] = res.headers.get('set-cookie') ?? '';
  }
  await serveApp(
    new Request(`${f.previewOrigin}/api/notes`, {
      method: 'POST',
      body: 'first-only',
      headers: { cookie: cookies[f.id], origin: f.previewOrigin },
    }),
    f.bindings,
  );
  const isolated = await serveApp(
    new Request(`${secondOrigin}/api/notes`, { headers: { cookie: cookies[second] } }),
    f.bindings,
  );
  expect(await isolated.json()).toEqual({ tag: 'v1', values: ['seed'] });
  const app = { ...f.app, mode: 'published' as const };
  f.bindings.PLATFORM.publishedApp = async (repo) => (repo === 'host' ? app : null);
  const published = await serveApp(
    new Request('https://app-host.example.com/api/notes'),
    f.bindings,
  );
  expect(await published.json()).toEqual({ tag: 'v1', values: ['seed'] });
  const credentials = await serveApp(
    new Request(`${f.previewOrigin}/headers`, {
      headers: {
        cookie: `${cookies[f.id]}; platform-session=sensitive`,
        authorization: 'Bearer sensitive',
      },
    }),
    f.bindings,
  );
  expect(await credentials.json()).toEqual({ headers: {}, url: 'https://app.invalid/headers' });
  expect(credentials.headers.get('set-cookie')).toBeNull();
});
it('accepts the platform-generated gateway URL with a trailing slash', async () => {
  const f = await fixture();
  expect((await serveApp(new Request(`${f.gateway}/`), f.bindings)).status).toBe(307);
});
it('preserves native candidate IDs containing colons when hashing and authorizing the encoded preview ID', async () => {
  const f = await fixture();
  const nativeId = 'host:candidate:job:capture:run-1:1';
  const origin = `https://preview-${(await sha(nativeId)).slice(0, 24)}.example.com`;
  f.bindings.PLATFORM.authorizeAppPreview = async (value, cap) =>
    value === nativeId && cap === token ? f.app : null;
  const exchange = await serveApp(
    new Request(`${origin}/v/${encodeURIComponent(nativeId)}/${token}/`),
    f.bindings,
  );
  expect(exchange.status).toBe(307);
  const cookie = exchange.headers.get('set-cookie') ?? '';
  expect(
    (await serveApp(new Request(`${origin}/api/notes`, { headers: { cookie } }), f.bindings))
      .status,
  ).toBe(200);
});
