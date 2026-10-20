// Read-only `git clone` access to a repository's object store: for a signed-in person who
// can read everything, never for tokens (agents and scripts use the API) or other stores.
import { expect, it } from 'vitest';
import type { Env } from '../../cloudflare/worker/types';
import { api, author, file, scoped, signup, usePlatformFixture } from './repo-fixture';

usePlatformFixture();

it('hands a person a read-only clone remote and refuses tokens', async () => {
  const owner = { cookie: await signup('cloner') };
  const created = await api('/repos', owner, { body: { name: 'c', policy: { required_checks: [], approvals: 0 }, files: [file('a.txt', 'a\n')], author } });
  const repo = `/repos/${created.body.id}`;
  const access = await api(`${repo}/clone`, owner, { body: {} });
  expect(access.status).toBe(200);
  expect(access.body.remote).toMatch(/^https:\/\/artifacts\.test\//);
  expect(access.body.expires_in_seconds).toBe(600);
  const minted = await api(`${repo}/tokens`, owner, { body: { name: 'agent', scopes: ['read'] } });
  const refused = await api(`${repo}/clone`, { token: minted.body.token }, { body: {} });
  expect(refused.status).toBe(403);
  expect(refused.body.token).toBeUndefined();
});

it('reports that an R2-backed repository cannot be cloned', async () => {
  const owner = { cookie: await signup('r2cloner') };
  const local = { ...scoped, PLATFORM_OBJECT_STORE: 'r2' } as unknown as Env;
  const created = await api('/repos', owner, { body: { name: 'r', policy: { required_checks: [], approvals: 0 }, files: [file('a.txt', 'a\n')], author } }, local);
  const access = await api(`/repos/${created.body.id}/clone`, owner, { body: {} }, local);
  expect(access.body.error.code).toBe('NOT_SUPPORTED');
});
