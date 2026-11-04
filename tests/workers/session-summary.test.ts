import { expect, it } from 'vitest';
import { accountRoute } from '../../cloudflare/worker/accounts';
import type { Env } from '../../cloudflare/worker/types';
import { bindings, signup, usePlatformFixture } from './repo-fixture';
usePlatformFixture();

it('authenticates bootstrap without fetching display details and rejects a revoked session', async () => {
  const cookie = await signup('fast_session');
  const calls: string[] = [];
  const workspaces = {
    idFromName: bindings.WORKSPACES.idFromName.bind(bindings.WORKSPACES),
    get(id: DurableObjectId) {
      const stub = bindings.WORKSPACES.get(id);
      return { fetch: async (input: RequestInfo, init?: RequestInit) => {
        const req = new Request(input, init);
        calls.push((await req.clone().json<{ op: string }>()).op);
        return stub.fetch(req);
      } };
    },
  } as unknown as DurableObjectNamespace;
  const env: Env = { ...bindings, WORKSPACES: workspaces };
  const req = () => new Request('https://yoneda/api/auth/session?summary=true', { headers: { cookie } });
  const answer = await accountRoute(req(), env);
  expect(await answer?.json()).toMatchObject({ authenticated: true, username: 'fast_session' });
  expect(calls).toEqual(['session']);
  const full = await accountRoute(new Request('https://yoneda/api/auth/session', { headers: { cookie } }), bindings);
  expect(await full?.json()).toHaveProperty('handle');
  await accountRoute(new Request('https://yoneda/api/auth/logout', { method: 'POST', headers: { cookie } }), bindings);
  expect(await (await accountRoute(req(), env))?.json()).toEqual({ authenticated: false });
});
