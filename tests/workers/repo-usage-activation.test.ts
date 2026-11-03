// Activation regressions use actual repository admission; only Analytics Engine is simulated.
import { beforeEach, expect, it, vi } from 'vitest';
import { forgetInternalAccounts } from '../../cloudflare/worker/internal-accounts';
import { forgetInsights, repoInsights } from '../../cloudflare/worker/platform-repo-insights';
import { type RepoContext } from '../../cloudflare/worker/repo-ops';
import type { Env } from '../../cloudflare/worker/types';
import { api, author, file, scoped, signup, usePlatformFixture } from './repo-fixture';

usePlatformFixture();
beforeEach(() => {
  forgetInsights();
  forgetInternalAccounts();
});
const enabled = () =>
  ({
    ...scoped,
    REPO_ANALYTICS: 'on',
    TRAFFIC_EVENTS: 'on',
    TRAFFIC_REPORT: 'on',
    SITE_EVENTS: { writeDataPoint: () => {} },
    CF_ACCOUNT_ID: 'f011d0ee02b23cad26b4b38151b204ad',
    SITE_EVENTS_DATASET: 'usage_events',
    ANALYTICS_READ_TOKEN: 'test-read-token',
  }) as unknown as Env;

it('advertises Insights only to viewers allowed to read the whole repository', async () => {
  const owner = { cookie: await signup('usage_scope_owner') };
  const made = await api('/repos', owner, {
    body: { name: 'usage-scope', files: [file('docs/readme.txt', 'example\n')], author },
  });
  const path = `/repos/${made.body.id}`;
  const token = (
    await api(`${path}/tokens`, owner, {
      body: { name: 'docs', scopes: ['read'], paths: ['docs/'] },
    })
  ).body.token;
  const env = enabled();
  const full = await api(`${path}?summary=true`, owner, {}, env);
  expect(full.status).toBe(200);
  expect(full.body.insights).toBe(true);
  const limited = await api(`${path}?summary=true`, { token }, {}, env);
  expect(limited.status).toBe(200);
  expect(limited.body.grant).toEqual(['docs/']);
  expect(limited.body.insights).toBeUndefined();
  expect((await api(`${path}/insights`, { token }, {}, env)).status).toBe(403);
});

it('does not reuse an earlier range window after its bucket boundary moves', async () => {
  const env = enabled();
  const call = vi.fn(async () => ({ contributors: [], more: false }));
  const ctx = { env, repo: 'r0123456789abcdef0123', call } as unknown as RepoContext;
  const fetcher = vi.fn<typeof fetch>(async () => Response.json({ data: [] }));
  await repoInsights(ctx, { range: '24h' }, fetcher, Date.parse('2026-11-03T10:59:00Z'));
  await repoInsights(ctx, { range: '24h' }, fetcher, Date.parse('2026-11-03T11:01:00Z'));
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(fetcher.mock.calls[0]?.[1]?.body).not.toBe(fetcher.mock.calls[1]?.[1]?.body);
});

it('checks current membership before returning already-held usage', async () => {
  const owner = { cookie: await signup('usage_revoke_owner') };
  const member = { cookie: await signup('usage_revoke_member') };
  const made = await api('/repos', owner, {
    body: { name: 'usage-revoke', files: [file('readme.txt', 'example\n')], author },
  });
  const path = `/repos/${made.body.id}`;
  await api(`${path}/members`, owner, { body: { account: 'usage_revoke_member', role: 'read' } });
  const env = enabled();
  const fetcher = vi
    .spyOn(globalThis, 'fetch')
    .mockImplementation(async () => Response.json({ data: [] }));
  expect((await api(`${path}/insights`, owner, {}, env)).body.usage.clones).toBe(0);
  expect((await api(`${path}/insights`, member, {}, env)).status).toBe(200);
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(
    (await api(`${path}/members/usage_revoke_member`, owner, { method: 'DELETE' })).status,
  ).toBe(200);
  expect((await api(`${path}/insights`, member, {}, env)).status).toBe(404);
  expect(fetcher).toHaveBeenCalledTimes(1);
});

it('does not mix datasets or turn a missing reader into an empty successful report', async () => {
  const env = enabled();
  const call = vi.fn(async () => ({ contributors: [], more: false }));
  const ctx = { env, repo: 'r0123456789abcdef0123', call } as unknown as RepoContext;
  const fetcher = vi.fn<typeof fetch>(async () => Response.json({ data: [] }));
  const now = Date.parse('2026-11-03T10:59:00Z');
  expect((await repoInsights(ctx, {}, fetcher, now)).usage?.clones).toBe(0);
  const other = { ...ctx, env: { ...env, SITE_EVENTS_DATASET: 'other_events' } } as RepoContext;
  expect((await repoInsights(other, {}, fetcher, now)).usage?.clones).toBe(0);
  expect(fetcher).toHaveBeenCalledTimes(2);
  const missing = { ...ctx, env: { ...env, ANALYTICS_READ_TOKEN: undefined } } as RepoContext;
  expect((await repoInsights(missing, {}, fetcher, now)).usage).toBeNull();
  expect(fetcher).toHaveBeenCalledTimes(2);
});
