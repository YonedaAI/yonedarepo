import { env } from 'cloudflare:workers';
import { reset } from 'cloudflare:test';
import { afterEach, expect, it } from 'vitest';
import type { Env } from '../../cloudflare/worker/types';

const bindings = env as unknown as Env;
afterEach(reset);

async function signup(username: string) {
  const response = await bindings.SELF.fetch('https://yoneda/api/auth/signup', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password: 'a long test password' }),
  });
  expect(response.status).toBe(200);
  return response.headers.get('set-cookie')!.split(';')[0];
}

it('returns the authenticated account identity even when its workspace has no repositories', async () => {
  const alice = await signup('alice');
  const bob = await signup('bob');
  for (const [cookie, username] of [[alice, 'alice'], [bob, 'bob']]) {
    const response = await bindings.SELF.fetch('https://yoneda/api/repositories', {
      headers: { cookie },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      repositories: [],
      identity: { role: 'user', username },
    });
    expect(response.headers.get('cache-control')).toBe('no-store');
  }
});

it('labels operator access separately and prefers the signed-in personal account', async () => {
  await bindings.INDEX.exec('CREATE TABLE repositories(id TEXT PRIMARY KEY,payload TEXT NOT NULL,seq INTEGER NOT NULL)');
  const authorization = 'Bearer local-test-owner';
  const operator = await bindings.SELF.fetch('https://yoneda/api/repositories', {
    headers: { authorization },
  });
  expect(operator.status).toBe(200);
  expect(await operator.json()).toEqual({ repositories: [], identity: { role: 'admin' } });
  const cookie = await signup('alice');
  const personal = await bindings.SELF.fetch('https://yoneda/api/repositories', {
    headers: { cookie, authorization },
  });
  expect((await personal.json<any>()).identity).toEqual({ role: 'user', username: 'alice' });
});

it('rejects a revoked session instead of returning the previous account identity', async () => {
  const cookie = await signup('alice');
  await bindings.SELF.fetch('https://yoneda/api/auth/logout', {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json' },
    body: '{}',
  });
  const response = await bindings.SELF.fetch('https://yoneda/api/repositories', {
    headers: { cookie },
  });
  expect(response.status).toBe(401);
  expect((await response.json<any>()).identity).toBeUndefined();
});
