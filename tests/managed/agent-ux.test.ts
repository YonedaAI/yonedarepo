// Agent set-up as the Agents pages drive it: Add agent records who set it up and when, Pause
// keeps the set-up (repositories, token) but starts nothing, Run now reviews open changes at
// their heads once, Archive turns the agent off everywhere and forgets its set-up, a
// repository's Agents page lists each agent's status and latest review, and "ready for review"
// skips changes marked as drafts.
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { QueueMessage } from '../../cloudflare/managed/config';
import { consume } from '../../cloudflare/managed/dispatch';
import { managedFetch } from '../../cloudflare/managed/index';
import { runAgent } from '../../cloudflare/managed/run';
import { fakeGateway, HEAD_A, HEAD_B, type Harness, harness, inline, newRepo } from './fake';
import { FIXTURES } from './fixtures';

afterEach(() => vi.restoreAllMocks());

const api = (h: Harness, path: string, init: RequestInit = {}) =>
  managedFetch(
    new Request(`https://site.example.com/api/managed/workspaces/${h.platform.account}${path}`, {
      ...init,
      headers: { cookie: 'session=owner', 'content-type': 'application/json' },
    }),
    h.env,
  );
const put = (h: Harness, agent: string, body: unknown) => api(h, `/agents/${agent}`, { method: 'PUT', body: JSON.stringify(body) });
const opened = (h: Harness, commit = HEAD_A, change = 1): QueueMessage => ({ kind: 'event', repo: h.platform.repo, event: 'change', ref: 'refs/heads/feature', commit, change, action: 'opened' });
const deliver = async (h: Harness, ...bodies: QueueMessage[]) => {
  const messages = bodies.map((body) => ({ body, ack: vi.fn(), retry: vi.fn() }));
  await consume({ messages } as unknown as MessageBatch<QueueMessage>, h.env);
};

async function setUp(agent = 'code-review') {
  const h = harness(newRepo());
  h.platform.change({ files: FIXTURES['code-review'].trigger.files });
  const res = await put(h, agent, { repos: [h.platform.repo], active: true });
  expect(res.status).toBe(200);
  return { h, state: await res.json<any>() };
}

describe('setting an agent up', () => {
  it('Add agent records who set it up and when; an agent never set up has neither', async () => {
    const { h, state } = await setUp();
    expect(state).toMatchObject({ created_by: 'owner', active: true, enabled_repos: [h.platform.repo] });
    expect(state.created_at).toBeGreaterThan(0);
    const other = await (await api(h, '/agents/slop-review')).json<any>();
    expect(other).toMatchObject({ created_by: null, created_at: null, active: true });
  });

  it('Pause keeps repositories and token but starts nothing; Resume runs again', async () => {
    const { h } = await setUp();
    fakeGateway();
    const paused = await (await put(h, 'code-review', { active: false })).json<any>();
    expect(paused).toMatchObject({ active: false, enabled_repos: [h.platform.repo] });
    expect(h.platform.revoked).toEqual([]);
    await deliver(h, opened(h));
    expect(h.created).toHaveLength(0);
    // Removing another agent from the repository does not disconnect it while this one is paused.
    await put(h, 'security-review', { repos: [h.platform.repo] });
    await put(h, 'security-review', { repos: [] });
    expect(h.platform.revoked).toEqual([]);
    expect((await put(h, 'code-review', { active: true })).status).toBe(200);
    await deliver(h, opened(h));
    expect(h.created).toHaveLength(1);
  });

  it('Run now reviews each open change at its head once', async () => {
    const { h } = await setUp();
    fakeGateway();
    h.platform.change({ number: 2, branch: 'other', head: HEAD_B, files: FIXTURES['code-review'].trigger.files });
    const first = await (await api(h, '/agents/code-review/run', { method: 'POST', body: '{}' })).json<any>();
    expect(first).toEqual({ started: 2, already: 0 });
    expect(h.created.map((c) => [c.change, c.head]).sort()).toEqual([[1, HEAD_A], [2, HEAD_B]]);
    const again = await (await api(h, '/agents/code-review/run', { method: 'POST', body: '{}' })).json<any>();
    expect(again).toEqual({ started: 0, already: 2 });
    // A paused agent runs nothing.
    await put(h, 'code-review', { active: false });
    expect(await (await api(h, '/agents/code-review/run', { method: 'POST', body: '{}' })).json<any>()).toEqual({ started: 0, already: 0 });
  });

  it('Archive turns it off everywhere and forgets its set-up', async () => {
    const { h } = await setUp();
    await put(h, 'code-review', { scope: h.platform.repo, settings: { trigger: { when: 'push', changes: 'ready_for_review', paths: ['src/'], branches: [] } } });
    const archived = await (await api(h, '/agents/code-review/archive', { method: 'POST', body: '{}' })).json<any>();
    expect(archived).toMatchObject({ created_by: null, created_at: null, enabled_repos: [], repo_overrides: {} });
    // The repository has no agent left: its token is revoked (the deletion notice stays).
    expect(h.platform.revoked).toContain('tokens:yoneda-managed-agents');
  });
});

describe("a repository's Agents page", () => {
  it('lists every agent with its status, harness and latest review', async () => {
    const { h } = await setUp();
    await put(h, 'security-review', { repos: [h.platform.repo] });
    await put(h, 'security-review', { active: false });
    fakeGateway();
    h.harness.scripts = [{ result: { summary: 's', findings: FIXTURES['code-review'].trigger.expected } }];
    await deliver(h, opened(h));
    await runAgent(h.env, h.created[0], inline);
    const rows = (await (await api(h, `/repos/${h.platform.repo}/agents`)).json<any>()).agents;
    expect(rows.map((r: any) => [r.id, r.status, r.harness])).toEqual([
      ['code-review', 'active', 'codex'],
      ['security-review', 'paused', 'claude-code'],
      ['slop-review', 'off', 'opencode'],
    ]);
    expect(rows[0].latest).toMatchObject({ change: 1, value: 'fail', status: 'findings' });
    expect(rows[1].latest).toBeNull();
    expect((await api(h, `/repos/${newRepo()}/agents`)).status).toBe(404);
  });
});

describe('ready for review', () => {
  it('skips a change whose title marks it as a draft', async () => {
    for (const [title, runs] of [['WIP: half done', 0], ['Draft: try this', 0], ['[WIP] later', 0], ['Fix the window', 1]] as const) {
      const h = harness(newRepo());
      h.platform.change({ title, files: FIXTURES['code-review'].trigger.files });
      await put(h, 'code-review', { repos: [h.platform.repo] });
      await deliver(h, opened(h));
      expect(h.created.length, title).toBe(runs);
    }
  });
});

