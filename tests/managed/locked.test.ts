// Managed agents are locked down: YonedaRepo maintains their name, description, harness,
// model, reasoning effort, time limit, instructions and result reading; a workspace chooses only
// when they run, which changes, where (repositories, or all of them including new ones) and
// whether they are active. Overrides stored before the lock are kept but no longer applied.
// "All repositories" can be chosen with none yet; a repository created later is connected the
// next time the owner's session reaches the managed API (the web app asks right after it
// creates or imports one), never by polling.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MANAGED_AGENTS, managedAgent } from '../../shared/managed-agents';
import { resolveSettings } from '../../shared/managed-settings';
import type { QueueMessage } from '../../cloudflare/managed/config';
import { consume } from '../../cloudflare/managed/dispatch';
import { managedFetch } from '../../cloudflare/managed/index';
import { runAgent } from '../../cloudflare/managed/run';
import { workspaceStub } from '../../cloudflare/managed/workspace-agents';
import { fakeGateway, HEAD_A, type Harness, harness, inline, newRepo } from './fake';
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
const put = (h: Harness, agent: string, body: unknown) =>
  api(h, `/agents/${agent}`, { method: 'PUT', body: JSON.stringify(body) });

describe('locked maintained fields', () => {
  const locked: [string, unknown][] = [
    ['name', 'Mine'],
    ['description', 'Mine too'],
    ['harness', 'codex'],
    ['provider', 'codex'],
    ['model', 'gpt-5.6-luna'],
    ['reasoning', 'high'],
    ['timeout_minutes', 10],
    ['instructions', 'Only check SQL.'],
  ];
  for (const [field, value] of locked)
    it(`refuses a change to ${field}`, async () => {
      const h = harness();
      const res = await put(h, 'code-review', { settings: { [field]: value } });
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ error: { code: 'INVALID_INPUT', message: expect.stringContaining('maintained by YonedaRepo') } });
    });

  it('accepts when to run, which changes and filters', async () => {
    const h = harness();
    const trigger = { when: 'ready', changes: 'ready_for_review', paths: ['src/'], branches: [] };
    const res = await put(h, 'code-review', { settings: { trigger } });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ settings: { trigger }, customized: ['trigger'] });
  });

  it('lets an owner set the level that blocks, on a level agent only', async () => {
    const h = harness();
    const res = await put(h, 'slop-review', { settings: { block_at: 'medium' } });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ settings: { block_at: 'medium' }, customized: ['block_at'] });
    // Never is a choice now the default blocks: it is kept, and the default clears it.
    const off = await put(h, 'slop-review', { settings: { block_at: null } });
    expect(await off.json()).toMatchObject({ settings: { block_at: null }, customized: ['block_at'] });
    const back = await put(h, 'slop-review', { settings: { block_at: 'high' } });
    expect(await back.json()).toMatchObject({ settings: { block_at: 'high' }, customized: [] });
    for (const [agent, value] of [
      ['slop-review', 'low'],
      ['slop-review', 'fail'],
      ['code-review', 'medium'],
      ['security-review', 'high'],
    ])
      expect((await put(h, agent, { settings: { block_at: value } })).status).toBe(400);
  });

  describe('settings saved before bad verdicts blocked by default', () => {
    const blockAt = async (h: Harness, agent: string) =>
      (await (await api(h, '')).json<any>()).agents.find((a: any) => a.id === agent).settings.block_at;
    const saved = (h: Harness, agent: 'slop-review' | 'intent-drift', scope: string, block_at: unknown) =>
      workspaceStub(h.env, h.platform.account).save(agent, scope, { block_at } as any, 'owner');

    it('a workspace that never chose gets the new default', async () => {
      const h = harness();
      expect(await blockAt(h, 'slop-review')).toBe('high');
      expect(await blockAt(h, 'intent-drift')).toBe('high');
    });
    it('a saved level stays, and so does a saved Never', async () => {
      const h = harness();
      await saved(h, 'slop-review', '', 'medium');
      await saved(h, 'intent-drift', '', null);
      expect(await blockAt(h, 'slop-review')).toBe('medium');
      expect(await blockAt(h, 'intent-drift')).toBeNull();
    });
    it('a repository keeps what it saved over its workspace', () => {
      const stored = { workspace: { block_at: 'medium' }, repos: { r1: { block_at: null } } } as any;
      const agent = managedAgent('slop-review')!;
      expect(resolveSettings(agent, stored.workspace, stored.repos.r1).block_at).toBeNull();
      expect(resolveSettings(agent, stored.workspace, stored.repos.r2).block_at).toBe('medium');
      expect(resolveSettings(agent).block_at).toBe('high');
    });
  });

  it('never lets a pass or fail agent hold a level', () => {
    expect(managedAgent('code-review')?.defaults.block_at).toBeNull();
    expect(managedAgent('security-review')?.defaults.block_at).toBeNull();
  });

  it('ignores overrides stored before the lock: every workspace runs the maintained defaults', async () => {
    const h = harness();
    h.platform.change({ files: FIXTURES['code-review'].trigger.files });
    expect((await put(h, 'code-review', { repos: [h.platform.repo] })).status).toBe(200);
    // Written as an older version would have, straight into the store.
    const ws = workspaceStub(h.env, h.platform.account);
    await ws.save('code-review', '', { instructions: 'Old custom prompt', model: 'gpt-5.6-luna', reasoning: 'high', name: 'Mine' }, 'owner');
    await ws.save('code-review', h.platform.repo, { timeout_minutes: 5 }, 'owner');
    const defaults = MANAGED_AGENTS.find((a) => a.id === 'code-review')!.defaults;
    const state = await (await api(h, '/agents/code-review')).json<any>();
    expect(state.settings).toEqual(defaults);
    expect(state.customized).toEqual([]);
    expect(state.repo_overrides).toEqual({});
    fakeGateway();
    const opened: QueueMessage = { kind: 'event', repo: h.platform.repo, event: 'change', ref: 'refs/heads/feature', commit: HEAD_A, change: 1, action: 'opened' };
    await consume({ messages: [{ body: opened, ack: vi.fn(), retry: vi.fn() }] } as unknown as MessageBatch<QueueMessage>, h.env);
    await runAgent(h.env, h.created[0], inline);
    expect(h.harness.started[0].spec).toMatchObject({
      model: defaults.model,
      reasoning: defaults.reasoning,
      instructions: defaults.instructions,
      timeout_ms: defaults.timeout_minutes * 60_000,
    });
    // The stored overrides are kept, only not applied.
    expect((await ws.settings('code-review')).workspace).toMatchObject({ instructions: 'Old custom prompt' });
  });
});

describe('all repositories, including new ones', () => {
  it('enables with no repository yet, and connects one created later on the next sync', async () => {
    const h = harness();
    h.platform.repos.length = 0;
    const res = await put(h, 'code-review', { all_repos: true, active: true });
    expect(res.status).toBe(200);
    // With no repository to ask about, a personal workspace's owner is its account.
    expect(await res.json()).toMatchObject({ all_repos: true, enabled_repos: [], active: true, created_by: h.platform.account });
    expect(h.platform.tokens).toEqual([]);
    // The owner creates a repository; the web app then asks the managed API to sync.
    const repo = newRepo();
    h.platform.repos.push(repo);
    const synced = await (await api(h, '/sync', { method: 'POST', body: '{}' })).json<any>();
    expect(synced).toEqual({ connected: 1 });
    const state = await (await api(h, '/agents/code-review')).json<any>();
    expect(state.enabled_repos).toEqual([repo]);
    expect(h.platform.tokens).toEqual([`/repos/${repo}/tokens:yoneda-managed-agents`]);
    // A second sync finds nothing new.
    expect(await (await api(h, '/sync', { method: 'POST', body: '{}' })).json<any>()).toEqual({ connected: 0 });
  });

  it('choosing repositories by hand turns "all repositories" off', async () => {
    const h = harness();
    await put(h, 'code-review', { all_repos: true });
    const state = await (await put(h, 'code-review', { repos: [h.platform.repo] })).json<any>();
    expect(state).toMatchObject({ all_repos: false, enabled_repos: [h.platform.repo] });
    h.platform.repos.push(newRepo());
    expect(await (await api(h, '/sync', { method: 'POST', body: '{}' })).json<any>()).toEqual({ connected: 0 });
  });
});
