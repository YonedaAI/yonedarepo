import { afterEach, expect, it, vi } from 'vitest';
import { managedFetch } from '../../cloudflare/managed/index';
import { fakeGateway, HEAD_A, HEAD_B, type Harness, harness, newRepo } from './fake';
import { FIXTURES } from './fixtures';

afterEach(() => vi.restoreAllMocks());
const call = (h: Harness, suffix: string, body: unknown) => managedFetch(new Request(
  `https://site.example.com/api/managed/workspaces/${h.platform.account}/agents/code-review${suffix}`,
  { method: suffix ? 'POST' : 'PUT', headers: { cookie: 'session=owner', 'content-type': 'application/json' }, body: JSON.stringify(body) },
), h.env);

async function ready() {
  const h = harness();
  h.platform.repos.push(newRepo());
  h.platform.change({ files: FIXTURES['code-review'].trigger.files });
  expect((await call(h, '', { repos: h.platform.repos })).status).toBe(200);
  const trigger = { when: 'push', changes: 'ready_for_review', paths: [], branches: ['?'] };
  expect((await call(h, '', { scope: h.platform.repo, settings: { trigger } })).status).toBe(200);
  fakeGateway();
  return h;
}

it('explicit Run now reviews only the requested exact head despite suppressed automatic triggers', async () => {
  const h = await ready();
  const overview = await managedFetch(new Request(`https://site.example.com/api/managed/workspaces/${h.platform.account}`, { headers: { cookie: 'session=owner' } }), h.env);
  expect(await overview.json()).toMatchObject({ capabilities: ['exact_head_review'] });
  const target = { repo: h.platform.repo, change: 1, head: HEAD_A };
  const res = await call(h, '/run', target);
  expect(res.status).toBe(200);
  expect(await res.json()).toMatchObject({ started: 1, already: 0 });
  expect(h.created).toHaveLength(1);
  expect(h.created[0]).toMatchObject(target);
  expect(await (await call(h, '/run', target)).json()).toMatchObject({ started: 0, already: 1 });
  expect(h.created).toHaveLength(1);
});

it('stale, unauthorized and incomplete exact targets start nothing', async () => {
  const h = await ready();
  for (const [body, status] of [
    [{ repo: h.platform.repo, change: 1, head: HEAD_B }, 409],
    [{ repo: newRepo(), change: 1, head: HEAD_A }, 403],
    [{ repo: h.platform.repo }, 400],
    [{ repo: h.platform.repo, change: 1, head: 'bad' }, 400],
  ] as const) expect((await call(h, '/run', body)).status).toBe(status);
  expect(h.created).toHaveLength(0);
});

it('manual selection retains pause, draft, enabled and owner access checks', async () => {
  const h = await ready();
  const target = { repo: h.platform.repo, change: 1, head: HEAD_A };
  h.platform.paused = true;
  expect((await call(h, '/run', target)).status).toBe(409);
  h.platform.paused = false;
  h.platform.change({ title: 'Draft: not ready' });
  expect(await (await call(h, '/run', target)).json()).toMatchObject({ started: 0 });
  expect((await call(h, '', { repos: [] })).status).toBe(200);
  expect((await call(h, '/run', target)).status).toBe(403);
  const refused = await managedFetch(new Request(
    `https://site.example.com/api/managed/workspaces/${h.platform.account}/agents/code-review/run`,
    { method: 'POST', headers: { cookie: 'session=reader', 'content-type': 'application/json' }, body: JSON.stringify(target) },
  ), h.env);
  expect(refused.status).toBe(403);
  expect(h.created).toHaveLength(0);
});

it('an empty Run now body keeps its existing workspace behavior', async () => {
  const h = harness();
  h.platform.change();
  expect((await call(h, '', { repos: [h.platform.repo] })).status).toBe(200);
  fakeGateway();
  expect(await (await call(h, '/run', {})).json()).toMatchObject({ started: 1 });
  expect(h.created).toHaveLength(1);
});
