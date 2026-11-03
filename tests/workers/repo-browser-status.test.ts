import { expect, it } from 'vitest';
import type { Env } from '../../cloudflare/worker/types';
import { api, author, file, scoped, signup, usePlatformFixture } from './repo-fixture';
usePlatformFixture();

it('loads browser metadata without querying storage shards and keeps full diagnostic status explicit', async () => {
  const owner = { cookie: await signup('browser-status') };
  const made = await api('/repos', owner, { body: { name: 'browser', policy: { required_checks: [], approvals: 0 }, files: [file('a.txt', 'a\n')], author } });
  expect(made.status).toBe(200);
  let reads = 0;
  const shards = { idFromName: () => { reads++; throw new Error('Storage diagnostics unavailable'); } } as unknown as DurableObjectNamespace;
  const env: Env = { ...scoped, COMMIT_SHARDS: shards };
  const path = `/repos/${made.body.id}`;
  const summary = await api(`${path}?summary=true`, owner, {}, env);
  expect(summary.status).toBe(200);
  expect(summary.body).toMatchObject({ name: 'browser', viewer: { owner: true } });
  expect(summary.body.refs).toBeDefined();
  expect(summary.body.policy).toBeDefined();
  expect(summary.body).not.toHaveProperty('objects');
  expect(reads).toBe(0);
  const denied = await api(`${path}?summary=true`, {}, {}, env);
  expect(denied.status).toBe(404);
  expect(reads).toBe(0);
  const full = await api(path, owner);
  expect(full.status).toBe(200);
  expect(full.body.objects).toBeDefined();
});

it('keeps public access and deletion behavior identical to full status', async () => {
  const owner = { cookie: await signup('browser-public') };
  const made = await api('/repos', owner, { body: { name: 'public-browser', visibility: 'public', policy: { required_checks: [], approvals: 0 }, files: [file('a.txt', 'a\n')], author } });
  const path = `/repos/${made.body.id}`;
  const shown = await api(`${path}?summary=true`, {});
  expect(shown.status).toBe(200);
  expect(shown.body.viewer.public).toBe(true);
  expect(shown.body).not.toHaveProperty('objects');
  expect((await api(`${path}?confirm=public-browser`, owner, { method: 'DELETE' })).status).toBe(200);
  const full = await api(path, owner);
  const summary = await api(`${path}?summary=true`, owner);
  expect(summary.status).toBe(full.status);
  expect(summary.body.error.code).toBe(full.body.error.code);
});
