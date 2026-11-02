// A deleted account here: agents forgotten, the card off Stripe, what is left of its credit
// written off, and a later account of the same name inheriting none of it.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { closeWorkspace } from '../../cloudflare/managed/close';
import { ledgerStub } from '../../cloudflare/managed/ledger';
import { workspaceStub } from '../../cloudflare/managed/workspace-agents';
import { paid } from './billing-fixture';

afterEach(() => vi.restoreAllMocks());

describe('closing a workspace', () => {
  it('detaches the card and writes off the credit once, keeping the entries', async () => {
    const { h, stripe, ledger } = await paid();
    const before = (await ledger.balance()).balance;
    expect(before).toBeGreaterThan(0);

    const closed = await closeWorkspace(h.env, h.platform.account);

    expect(closed.forfeited_usd).toBe(before / 1_000_000);
    expect(stripe.detached).toEqual(['pm_card_1']);
    expect((await ledger.balance()).balance).toBe(0);
    const again = await closeWorkspace(h.env, h.platform.account);
    expect(again.forfeited_usd).toBe(0);
    expect((await ledger.balance()).balance).toBe(0);
    const state = await ledgerStub(h.env, h.platform.account).adminState();
    expect(state.customer).toBeNull();
    expect(state.card).toBeNull();
    expect(state.auto_top_up).toBe(false);
    expect(state.top_ups.length).toBeGreaterThan(0);
  });

  it('forgets every agent’s set-up', async () => {
    const { h } = await paid();
    const ws = workspaceStub(h.env, h.platform.account);
    await ws.setEnabled('slop-review' as never, ['r00000000000000000001']);

    await closeWorkspace(h.env, h.platform.account);

    expect(await ws.reposInUse()).toEqual([]);
  });
});
