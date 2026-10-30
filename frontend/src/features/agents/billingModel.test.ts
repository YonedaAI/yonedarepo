// Agent billing as the pages print it: the card label, the top-up rule, the promotional credit
// copy with and without a card, the gate on creating your own agents, and the return from
// Stripe.
import { describe, expect, it } from 'vitest';
import type { ManagedCredit } from '../../../../shared/managed-agents';
import {
  cardLabel,
  cardSaveState,
  promoCopy,
  RETURN_PATH,
  removeCardPath,
  setupPath,
  topUpDay,
  topUpFailedText,
  topUpRule,
  topUpStatusLabel,
  topUpTone,
} from './billingModel';

const credit = (over: Partial<ManagedCredit> = {}): ManagedCredit => ({
  granted_usd: 5,
  used_usd: 0.4,
  balance_usd: 4.6,
  paused: false,
  promo: { usd: 100, granted: false },
  card: null,
  top_up_failed: null,
  ...over,
});
const card = { brand: 'visa', last4: '4242', added_at: 1 };

describe('agent billing', () => {
  it('labels a card by brand and last four only', () => {
    expect(cardLabel(card)).toBe('Visa •••• 4242');
    expect(cardLabel({ brand: 'amex', last4: '0005' })).toBe('American Express •••• 0005');
    expect(cardLabel({ brand: 'newbrand', last4: '1111' })).toBe('newbrand •••• 1111');
  });

  it('states the automatic top-up rule', () => {
    expect(topUpRule({ below_usd: 5, add_usd: 20 })).toBe(
      'Auto top-up: $20.00 when the balance falls below $5.00',
    );
  });

  it('offers the promotional credit without a card, and says when the starting credit is added', () => {
    const none = promoCopy(credit(), 'stripe');
    expect(none.title).toBe('This one is on us!');
    expect(none.body).toContain('$5.00 of starting credit when you set up your first agent');
    expect(none.body).not.toMatch(/first run/);
    expect(none.action).toBe('Add a card to unlock $100.00');
    expect(promoCopy(credit(), 'coming').action).toBe('Card billing is coming');
    const withCard = promoCopy(credit({ card, promo: { usd: 100, granted: true } }), 'stripe');
    expect(withCard.title).toBe('Agent credit');
    expect(withCard.body).toContain('Your card unlocked $100.00 of promotional credit');
    expect(withCard).not.toHaveProperty('action');
  });

  it('opens Create your own only with a card on file', () => {});

  it('waits for the webhook after Stripe, then gives up politely', () => {
    expect(cardSaveState(false, null, 0)).toBe('none');
    expect(cardSaveState(true, null, 1)).toBe('waiting');
    expect(cardSaveState(true, card, 1)).toBe('saved');
    expect(cardSaveState(true, null, 5)).toBe('late');
    expect(RETURN_PATH).toBe('/settings?billing=added');
  });

  it('describes top-ups and their failure', () => {
    expect([topUpStatusLabel('succeeded'), topUpTone('succeeded')]).toEqual(['Added', 'good']);
    expect([topUpStatusLabel('failed'), topUpTone('failed')]).toEqual(['Failed', 'bad']);
    expect([topUpStatusLabel('pending'), topUpTone('pending')]).toEqual(['Charging', 'neutral']);
    expect(topUpDay(Date.UTC(2026, 9, 30, 23, 59))).toBe('2026-10-30');
    expect(topUpFailedText('card declined')).toMatch(
      /^The last automatic top-up failed \(card declined\)\. Agent runs stop when your credit runs out/,
    );
  });

  it('addresses the billing endpoints', () => {
    expect(setupPath('dev.owner+x@example.com')).toBe(
      '/workspaces/dev.owner%2Bx%40example.com/billing/setup',
    );
    expect(removeCardPath('ada')).toBe('/workspaces/ada/billing/card/remove');
  });
});
