// The four gaps closed after the first review: tokens and hook secrets sealed at rest, the
// token and webhook revoked once no agent runs on a repository, stale credit holds released,
// and the owner's automation pause honoured.
import { runInDurableObject } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { QueueMessage } from '../../cloudflare/managed/config';
import { consume } from '../../cloudflare/managed/dispatch';
import { managedFetch } from '../../cloudflare/managed/index';
import { ledgerStub, STALE_HOLD_MS } from '../../cloudflare/managed/ledger';
import { repoStub } from '../../cloudflare/managed/repo-agents';
import { runAgent } from '../../cloudflare/managed/run';
import { fakeGateway, HEAD_A, HOOK_SECRET, type Harness, harness, inline, signature } from './fake';

afterEach(() => vi.restoreAllMocks());

const put = (h: Harness, agent: string, body: unknown) =>
  managedFetch(
    new Request(`https://site.example.com/api/managed/workspaces/${h.platform.account}/agents/${agent}`, {
      method: 'PUT',
      headers: { cookie: 'session=owner', 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
    h.env,
  );
const opened = (h: Harness): QueueMessage => ({
  kind: 'event',
  repo: h.platform.repo,
  event: 'change',
  ref: 'refs/heads/feature',
  commit: HEAD_A,
  change: 1,
  action: 'opened',
});
async function deliver(h: Harness, ...bodies: QueueMessage[]) {
  const messages = bodies.map((body) => ({ body, ack: vi.fn(), retry: vi.fn() }));
  await consume({ messages } as unknown as MessageBatch<QueueMessage>, h.env);
}

describe('sealed connection', () => {
  it('stores the token and hook secret encrypted, and fails closed without the vault key', async () => {
    const h = harness();
    h.platform.change();
    expect((await put(h, 'code-review', { repos: [h.platform.repo] })).status).toBe(200);
    const stub = repoStub(h.env, h.platform.repo);
    await runInDurableObject(stub as DurableObjectStub, (_i, state) => {
      const row = state.storage.sql.exec('SELECT * FROM connection').one();
      const text = JSON.stringify(row);
      expect(text).not.toContain('yrp_fixture');
      expect(text).not.toContain(HOOK_SECRET);
      expect(JSON.parse(String(row.token_sealed))).toMatchObject({ v: 1 });
    });
    expect((await stub.connection())?.token).toBe('yrp_fixture_yoneda-managed-agents');
    // The signature still verifies (opened inside the Durable Object only).
    const body = JSON.stringify({ event: 'change', action: 'opened', repo: h.platform.repo, commit: HEAD_A, change: { number: 1 } });
    const hook = (sig: string) =>
      managedFetch(new Request(`https://managed.example.com/hooks/${h.platform.repo}`, { method: 'POST', headers: { 'x-yoneda-signature': sig }, body }), h.env);
    expect((await hook(await signature(HOOK_SECRET, body))).status).toBe(202);
    // Another repository's row does not open under this repository's additional data.
    await runInDurableObject(stub as DurableObjectStub, async (instance: any, state) => {
      state.storage.sql.exec("UPDATE connection SET repo = 'r00000000000000000000'");
      await expect(instance.connection()).rejects.toThrow(/Decryption failed/);
    });
    expect((await hook(await signature(HOOK_SECRET, body))).status).toBe(401);
  });
});

describe('disable', () => {
  it('revokes the token and swaps the webhook for a deletion notice once no agent runs there', async () => {
    const h = harness();
    h.platform.change();
    await put(h, 'code-review', { repos: [h.platform.repo] });
    await put(h, 'security-review', { repos: [h.platform.repo] });
    await put(h, 'code-review', { repos: [] });
    expect(h.platform.revoked).toEqual([]);
    await put(h, 'security-review', { repos: [] });
    expect(h.platform.revoked).toEqual(['tokens:yoneda-managed-agents', 'hooks:7']);
    expect(h.platform.hooks.map((x) => x.events)).toEqual([['change', 'branch', 'repo'], ['repo']]);
    expect(await repoStub(h.env, h.platform.repo).connection()).toMatchObject({ revoked: true, hook_id: 8 });
    // A revoked connection starts nothing.
    fakeGateway();
    await deliver(h, opened(h));
    expect(h.created).toHaveLength(0);
    // Enabling again mints a fresh token (names are never reused) and a fresh agents hook.
    expect((await put(h, 'code-review', { repos: [h.platform.repo] })).status).toBe(200);
    const again = await repoStub(h.env, h.platform.repo).connection();
    expect(again).toMatchObject({ revoked: false });
    expect(again?.token_name).toMatch(/^yoneda-managed-agents-[a-z0-9]+$/);
    expect(h.platform.revoked).toContain('hooks:8');
    expect(h.platform.hooks).toHaveLength(3);
  });
});

describe('stale holds', () => {
  it('arms an alarm with the first hold and releases holds nobody settled in time', async () => {
    const h = harness();
    const ledger = ledgerStub(h.env, h.platform.account);
    await ledger.ensureStartingCredit();
    const meta = { repo: 'r', run: 'lost', agent: 'code-review', model: 'glm-5.3-flash' };
    await ledger.hold('lost:1:a', 40_000, meta);
    await runInDurableObject(ledger as DurableObjectStub, async (_i, state) => {
      expect(await state.storage.getAlarm()).not.toBeNull();
    });
    expect((await ledger.balance()).balance).toBe(5_000_000 - 40_000);
    expect(await ledger.releaseStale(Date.now())).toBe(0);
    expect(await ledger.releaseStale(Date.now() + STALE_HOLD_MS + 1)).toBe(1);
    expect(await ledger.balance()).toEqual({ granted: 5_000_000, used: 0, balance: 5_000_000 });
    expect(await ledger.releaseStale(Date.now() + STALE_HOLD_MS + 1)).toBe(0);
  });
});

describe('automation pause', () => {
  it('starts no run while the owner paused automation, and a queued run stops at prepare', async () => {
    const h = harness();
    h.platform.change();
    await put(h, 'code-review', { repos: [h.platform.repo] });
    fakeGateway();
    h.platform.paused = true;
    await deliver(h, opened(h));
    expect(h.created).toHaveLength(0);
    h.platform.paused = false;
    await deliver(h, opened(h));
    expect(h.created).toHaveLength(1);
    h.platform.paused = true;
    expect(await runAgent(h.env, h.created[0], inline)).toEqual({ status: 'stopped', reason: 'automation_paused' });
    expect(h.harness.started).toHaveLength(0);
  });
});
