// An explicit Run now can recover a failed reading without another code push. Delivery
// retries and repeated clicks still start only one paid attempt of the exact current head.
import { afterEach, expect, it, vi } from 'vitest';
import { runInDurableObject } from 'cloudflare:test';
import type { QueueMessage } from '../../cloudflare/managed/config';
import { consume } from '../../cloudflare/managed/dispatch';
import { managedFetch } from '../../cloudflare/managed/index';
import { ledgerStub } from '../../cloudflare/managed/ledger';
import { repoStub } from '../../cloudflare/managed/repo-agents';
import { runAgent } from '../../cloudflare/managed/run';
import { migrate, REPO_SCHEMA } from '../../cloudflare/managed/schema';
import { fakeGateway, HEAD_A, HEAD_B, harness, inline, type Harness } from './fake';

afterEach(() => vi.restoreAllMocks());

const api = (h: Harness, path: string, method = 'GET', cookie = 'session=owner') =>
  managedFetch(new Request(`https://site.example.com/api/managed/workspaces/${h.platform.account}${path}`, {
    method, headers: { cookie, 'content-type': 'application/json' }, ...(method === 'POST' && { body: '{}' }),
  }), h.env);
const now = async (h: Harness) => (await api(h, '/agents/code-review/run', 'POST')).json<any>();

async function ready() {
  const h = harness();
  h.platform.change({ files: [] });
  h.platform.required = ['code-review'];
  const enabled = await managedFetch(new Request(`https://site.example.com/api/managed/workspaces/${h.platform.account}/agents/code-review`, {
    method: 'PUT', headers: { cookie: 'session=owner', 'content-type': 'application/json' }, body: JSON.stringify({ repos: [h.platform.repo] }),
  }), h.env);
  expect(enabled.status).toBe(200);
  fakeGateway();
  h.harness.scripts = [{ error: 'provider unavailable' }];
  expect(await now(h)).toEqual({ started: 1, already: 0 });
  return h;
}

it('retries a failed reading once, preserves its evidence, and fences its old workflow', async () => {
  const h = await ready();
  const first = h.created[0];
  expect(await runAgent(h.env, first, inline)).toMatchObject({ status: 'failed' });
  const previous = await repoStub(h.env, h.platform.repo).run(first.run);
  const used = (await ledgerStub(h.env, h.platform.account).balance()).used;
  // A redelivered webhook cannot authorize another paid attempt.
  const body: QueueMessage = { kind: 'event', repo: h.platform.repo, event: 'change', ref: 'refs/heads/feature', commit: HEAD_A, change: 1, action: 'opened' };
  await consume({ messages: [{ body, ack: vi.fn(), retry: vi.fn() }] } as unknown as MessageBatch<QueueMessage>, h.env);
  expect(h.created).toHaveLength(1);

  const clicks = await Promise.all([now(h), now(h)]);
  expect(clicks.map(x => x.started).sort()).toEqual([0, 1]);
  expect(h.created.map(p => p.attempt)).toEqual([1, 2]);
  await repoStub(h.env, h.platform.repo).finish(first.run, first.attempt, 'failed', { error: 'late old failure' });
  expect((await repoStub(h.env, h.platform.repo).run(first.run))!.status).toBe('queued');
  const before = h.platform.checks.length;
  expect(await runAgent(h.env, first, inline)).toEqual({ status: 'stopped', reason: 'stale' });
  expect(h.platform.checks).toHaveLength(before);
  expect((await ledgerStub(h.env, h.platform.account).balance()).used).toBe(used);
  h.harness.scripts = [{ result: { summary: 'Recovered review', findings: [] } }];
  expect(await runAgent(h.env, h.created[1], inline)).toMatchObject({ status: 'passed' });
  expect(h.platform.comments.map(c => c.body).join('\n')).toContain('Recovered review');
  expect(h.platform.comments.filter(c => !c.path)).toHaveLength(2);
  expect(new Set(h.harness.started.map(x => x.name)).size).toBe(2);
  const detail = await (await api(h, `/runs/${h.platform.repo}/${first.run}`)).json<any>();
  expect(detail.previous_attempts).toEqual([{ attempt: 1, run: previous, findings: [] }]);
  expect(detail.run.cost_usd).toBeGreaterThanOrEqual(previous!.cost_usd);
  expect(detail.run.status).toBe('passed');
  expect((await api(h, `/runs/${h.platform.repo}/${first.run}`, 'GET', 'session=reader')).status).toBe(403);
  expect(await now(h)).toEqual({ started: 0, already: 1 });
});

it('does not publish a terminal failure until its failing check has settled', async () => {
  const h = await ready();
  let arrive = () => {};
  let release = () => {};
  const reached = new Promise<void>(r => { arrive = r; });
  const open = new Promise<void>(r => { release = r; });
  const fetch = h.platform.fetch;
  h.env.PLATFORM = { fetch: async (req: Request) => {
    if (req.method === 'POST' && new URL(req.url).pathname.endsWith('/checks')) { arrive(); await open; }
    return fetch(req);
  } } as Fetcher;
  const failing = runAgent(h.env, h.created[0], inline);
  await reached;
  try {
    expect(await now(h)).toEqual({ started: 0, already: 1 });
    expect(h.created).toHaveLength(1);
  } finally { release(); await failing; }
  expect(await now(h)).toEqual({ started: 1, already: 0 });
});

it('uses the current head and current credit admission instead of reviving stale work', async () => {
  const h = await ready();
  await runAgent(h.env, h.created[0], inline);
  h.platform.change({ head: HEAD_B, files: [] });
  expect(await now(h)).toEqual({ started: 1, already: 0 });
  expect(h.created.map(p => [p.head, p.attempt])).toEqual([[HEAD_A, 1], [HEAD_B, 1]]);
  const ledger = ledgerStub(h.env, h.platform.account);
  await ledger.charge('exhausted-fixture', (await ledger.balance()).balance, { repo: h.platform.repo, run: h.created[0].run, agent: 'code-review', model: 'gpt-5.6-luna' }, 'Fixture exhausted credit');
  const started = h.harness.started.length;
  expect(await runAgent(h.env, h.created[1], inline)).toMatchObject({ status: 'paused', reason: 'no credit' });
  expect(h.harness.started).toHaveLength(started);
});

it('upgrades the preceding schema without changing an existing failed reading', async () => {
  const h = await ready();
  await runAgent(h.env, h.created[0], inline);
  const stub = repoStub(h.env, h.platform.repo);
  const before = await stub.run(h.created[0].run);
  await runInDurableObject(stub as unknown as DurableObjectStub, (_instance, state) => {
    const sql = state.storage.sql;
    sql.exec('DROP TABLE run_attempts');
    sql.exec('UPDATE schema_version SET version = 3');
    expect(migrate(sql, REPO_SCHEMA)).toBe(4);
    expect(migrate(sql, REPO_SCHEMA)).toBe(4);
    expect(sql.exec('SELECT * FROM run_attempts').toArray()).toEqual([]);
  });
  expect(await stub.run(h.created[0].run)).toEqual(before);
});
