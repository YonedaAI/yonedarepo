// Self is a transport alias only: actual native sessions and existing managed access decide.
import { expect, it, vi } from 'vitest';
import { accountRoute } from '../../cloudflare/worker/accounts';
import { frontFetch } from '../../cloudflare/worker/front-routes';
import { platformFetch } from '../../cloudflare/worker/platform-routes';
import type { Env } from '../../cloudflare/worker/types';
import type { ManagedEnv } from '../../cloudflare/managed/config';
import { Platform } from '../../cloudflare/managed/platform';
import { access } from '../../cloudflare/managed/workspace-read';
import { bindings, signup, usePlatformFixture } from './repo-fixture';
usePlatformFixture();

function transport() {
  const calls: string[] = [];
  const platform = { fetch: async (req: Request) => {
    calls.push(new URL(req.url).pathname);
    return platformFetch(req, bindings);
  } };
  const managed = { fetch: vi.fn(async (req: Request) => {
    const url = new URL(req.url);
    const workspace = decodeURIComponent(url.pathname.split('/').at(-1)!);
    try {
      await access(new Platform({ PLATFORM: platform } as unknown as ManagedEnv, { forward: req }), workspace);
      return Response.json({ workspace, cookie: req.headers.get('cookie'), origin: req.headers.get('origin') },
        { headers: { 'cache-control': 'no-store' } });
    } catch (e: any) {
      return Response.json({ error: { code: e.code } }, { status: e.status ?? 503 });
    }
  }) };
  return { env: { ...bindings, MANAGED: managed } as unknown as Env, calls, managed };
}
const ask = (cookie?: string, suffix = '', init: RequestInit = {}) => new Request(`https://yoneda/api/managed/self${suffix}`, {
  ...init, headers: { ...(cookie ? { cookie } : {}), ...init.headers },
});

it('routes a cookie account without an extra auth hop, retaining native admission and three managed reads', async () => {
  const cookie = await signup('self_read');
  const h = transport();
  const response = await frontFetch(ask(cookie, '', { headers: { origin: 'https://yoneda' }, cf: { continent: 'EU', colo: 'FRA' } }), h.env);
  expect(response.status).toBe(200);
  expect(response.headers.get('cache-control')).toBe('no-store');
  expect(await response.json()).toEqual({ workspace: 'self_read', cookie, origin: 'https://yoneda' });
  expect(h.managed.fetch.mock.calls[0][0].cf).toMatchObject({ continent: 'EU', colo: 'FRA' });
  expect(h.calls.sort()).toEqual(['/api/auth/session', '/api/v1/orgs', '/api/v1/repos']);
  expect(new URL(h.managed.fetch.mock.calls[0][0].url).pathname).toBe('/api/managed/workspaces/self_read');
});

it('refuses selectors, non-GETs and non-cookie credentials without forwarding', async () => {
  const cookie = `yoneda_account=self_read.${'a'.repeat(64)}`;
  const h = transport();
  const bodyRead = ask(cookie, '', { method: 'POST', body: 'selector' });
  Object.defineProperty(bodyRead, 'method', { value: 'GET' });
  for (const [req, status] of [
    [ask(), 401], [ask('yoneda_account=invalid'), 401],
    [ask(cookie, '?workspace=other'), 400], [ask(cookie, '', { method: 'POST' }), 405],
    [ask(cookie, '', { headers: { authorization: 'Bearer fixture' } }), 401],
    [ask(undefined, '', { headers: { authorization: 'Bearer fixture' } }), 401],
    [bodyRead, 400],
  ] as const) expect((await frontFetch(req, h.env)).status).toBe(status);
  expect(h.managed.fetch).not.toHaveBeenCalled();
});

it('does not authorize a forged or revoked cookie through its account routing hint', async () => {
  const cookie = await signup('self_revoked');
  const h = transport();
  const forged = cookie.replace(/\.[a-f0-9]{64}/, `.${'0'.repeat(64)}`);
  expect((await frontFetch(ask(forged), h.env)).status).toBe(401);
  await accountRoute(new Request('https://yoneda/api/auth/logout', { method: 'POST', headers: { cookie } }), bindings);
  expect((await frontFetch(ask(cookie), h.env)).status).toBe(401);
  expect(h.calls.filter((p) => p === '/api/auth/session')).toHaveLength(2);
});
