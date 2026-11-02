// The platform's routes run through `serveHere`, as a hinted combiner runs them in a region: real
// routes, repository objects and D1 (workerd), with each binding that can leave the region counted
// in Server-Timing. Whether a hop really leaves is a live question; here it only has to be seen.
import { expect, it, vi } from 'vitest';
import { meteredEnv, serveHere } from '../../cloudflare/worker/repo-region-serve';
import type { Env } from '../../cloudflare/worker/types';
import { author, bindings, file, scoped, signup, usePlatformFixture } from './repo-fixture';

usePlatformFixture();

const on = { ...scoped, REGION_HINT_TEST: 'on', ACCOUNT_SEARCH: 'on' } as unknown as Env;
const later: Promise<unknown>[] = [];

async function serve(path: string, who: { cookie?: string; token?: string }, body?: unknown) {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (who.cookie) headers.cookie = who.cookie;
  if (who.token) headers.authorization = `Bearer ${who.token}`;
  const request = new Request(`https://yoneda${path}`, { method: body ? 'POST' : 'GET', headers, body: body ? JSON.stringify(body) : undefined });
  const response = await serveHere(request, on, (work) => later.push(work));
  await Promise.all(later.splice(0));
  const timing = response.headers.get('server-timing') ?? '';
  const parsed = await response.json<any>().catch(() => ({}));
  return { status: response.status, body: parsed, timing, hops: [...timing.matchAll(/hop\.([a-z0-9]+);/g)].map((m) => m[1]) };
}

async function repository(cookie: string) {
  const made = await serve('/api/v1/repos', { cookie }, { name: 'region-hint-serve', policy: { approvals: 0, required_checks: [] }, files: [file('a.md', 'a\n')], author, tokens: [{ name: 't', scopes: ['read', 'write', 'land'] }] });
  expect(made.status).toBe(200);
  return { id: made.body.id as string, token: made.body.tokens[0].token as string, hops: made.hops };
}

it('off, a combiner serves nothing', async () => {
  const stub = bindings.LAND_COMBINERS!.get(bindings.LAND_COMBINERS!.idFromName('region-serve:weur'));
  const answer = await stub.fetch('https://yoneda/api/v1/repos');
  expect(answer.status).toBe(404);
});

it('a create shows what it reached: the account, D1, and the queue', async () => {
  const cookie = await signup('serveone');
  const { hops } = await repository(cookie);
  expect(hops).toEqual(expect.arrayContaining(['authority', 'd1', 'queue']));
});

it('a personal token pays D1 and the account, and a repository token neither', async () => {
  const cookie = await signup('servetwo');
  const { id, token } = await repository(cookie);
  const pat = (await serve('/api/v1/tokens', { cookie }, { name: 'p', scopes: ['repo:read'], expires_days: 1 })).body.token;
  const own = await serve(`/api/v1/repos/${id}/refs`, { token });
  expect(own.status).toBe(200);
  expect(own.hops).not.toContain('d1');
  expect(own.hops).not.toContain('authority');
  const personal = await serve(`/api/v1/repos/${id}/refs`, { token: pat });
  expect(personal.status).toBe(200);
  expect(personal.hops).toEqual(expect.arrayContaining(['d1', 'authority']));
});

it('a land goes through the combiner, and Git and sign-in answer here too', async () => {
  const cookie = await signup('servethree');
  const { id, token } = await repository(cookie);
  const made = await serve(`/api/v1/repos/${id}/commits`, { token }, { ref: 'main', changes: [file('b.md', 'b\n')], message: 'b', author });
  expect(made.status).toBe(200);
  expect(made.hops).toContain('shard');
  const landed = await serve(`/api/v1/repos/${id}/land`, { token }, { ref: 'main', commit: made.body.commit });
  expect(landed.status).toBe(200);
  expect(landed.hops).toContain('combiner');
  const refs = await serve(`/git/${id}.git/info/refs?service=git-upload-pack`, { token });
  expect(refs.status).toBe(200);
  // No route timing of its own: the phases come from `serveHere`.
  const refused = await serve('/api/auth/login', {}, { username: 'nobody@example.com', password: 'wrong password here' });
  expect(refused.status).toBe(401);
  expect(refused.timing).toContain('total;dur=');
  expect(refused.hops).toContain('authority');
});

it('a refusal is the same refusal through the region', async () => {
  const answer = await serve('/api/v1/repos', {}, { name: 'x' });
  expect(answer.status).toBe(401);
  expect(answer.body.error.code).toBe('UNAUTHORIZED');
});

it('the meter calls a real RPC stub as itself: `.bind` on one is a remote call', async () => {
  const near = meteredEnv({ ...on, LAND_COMBINERS: bindings.LAND_COMBINERS } as Env);
  const namespace = near.LAND_COMBINERS as DurableObjectNamespace;
  const stub = namespace.get(namespace.idFromName('region-hint-meter')) as unknown as { where(): Promise<string> };
  const trace = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response('colo=TST\n'));
  await expect(stub.where()).resolves.toBe('TST');
  trace.mockRestore();
});
