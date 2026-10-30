// Settings → Billing and the Agents page's credit card rendered from managed answers
// (useSource mocked per path): with and without a card, card billing on or still coming, the
// failed top-up banner, top-ups and usage.
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BillingState, ManagedCredit } from '../../../../shared/managed-agents';
import type { Loaded } from '../source-platform/useSource';

const answers = vi.hoisted(() => ({ byPath: new Map<string, Partial<Loaded<unknown>>>() }));
vi.mock('../source-platform/useSource', () => ({
  useSource: (path: string | null) => ({
    loading: false,
    reload: () => {},
    ...(answers.byPath.get(path ?? '') ?? { loading: true }),
  }),
}));

const { BillingSettings } = await import('../account-settings/BillingSettings');
const { PromoCard } = await import('./PromoCard');

const repoA = 'r0000000000000000000a';
const render = (component: unknown, props: object) =>
  renderToStaticMarkup(createElement(component as never, props));
const card = { brand: 'visa', last4: '4242', added_at: 1 };
const credit = (over: Partial<ManagedCredit> = {}): ManagedCredit => ({
  granted_usd: 5,
  used_usd: 0.3,
  balance_usd: 4.7,
  paused: false,
  promo: { usd: 100, granted: false },
  card: null,
  top_up_failed: null,
  auto_top_up: true,
  ...over,
});
const billing = (over: Partial<BillingState> = {}): BillingState => ({
  workspace: 'ada',
  credit: credit(),
  payment_method: null,
  billing: 'stripe',
  auto_top_up: { below_usd: 5, add_usd: 20, enabled: true },
  top_ups: [],
  usage: [{ repo: repoA, repo_name: 'parser', agent: 'code-review', runs: 3, cost_usd: 0.3 }],
  ...over,
});

/** The titles of the page's cards, in order. */
const cards = (html: string) =>
  [...html.matchAll(/<section class="settings-card"[^>]*><h2[^>]*>([^<]+)</g)].map((m) => m[1]);
/** One titled card's markup. */
const cardOf = (html: string, title: string) => {
  const start = html.lastIndexOf('<section', html.indexOf(`>${title}<`));
  return html.slice(start, html.indexOf('</section>', start));
};

beforeEach(() => answers.byPath.clear());

describe('Settings → Billing', () => {
  it('offers a card when there is none, and says what it unlocks', () => {
    answers.byPath.set('/workspaces/ada/billing', { data: billing() });
    const html = render(BillingSettings, { workspace: 'ada' });
    expect(html).toContain('$4.70');
    expect(html).toContain('including the starting credit added when you set up your first agent');
    expect(html).not.toContain('first run');
    expect(html).toContain('Adding a card unlocks $100.00 of promotional credit');
    expect(html).toContain('No card on file');
    expect(cards(html)).toEqual([
      'Credit balance',
      'Payment method',
      'Top-ups',
      'Usage by repository and agent',
    ]);
    // Without a card there is nothing to switch off.
    expect(html).not.toContain('Automatic top-up');
    // One Add a card, next to what it unlocks.
    expect(html.match(/<button type="button">Add a card<\/button>/g)).toHaveLength(1);
    expect(cardOf(html, 'Credit balance')).toContain('>Add a card<');
    expect(cardOf(html, 'Payment method')).not.toContain('>Add a card<');
    expect(html).toContain('No top-ups yet');
    expect(html).toContain('<td>parser</td><td>Code review</td><td>3</td><td>$0.30</td>');
    answers.byPath.set('/workspaces/ada/billing', {
      data: billing({ billing: 'coming', usage: [] }),
    });
    const coming = render(BillingSettings, { workspace: 'ada' });
    expect(coming).toMatch(
      /<button type="button" disabled="" title="Card billing is coming">Add a card/,
    );
    expect(coming).toContain('No agent has run yet');
    expect(cards(coming)).toContain('Usage by repository and agent');
  });

  it('keeps Add a card under Payment method once the promotion is used', () => {
    answers.byPath.set('/workspaces/ada/billing', {
      data: billing({ credit: credit({ promo: { usd: 100, granted: true } }) }),
    });
    const html = render(BillingSettings, { workspace: 'ada' });
    expect(html).not.toContain('Adding a card unlocks');
    expect(cardOf(html, 'Credit balance')).not.toContain('>Add a card<');
    expect(cardOf(html, 'Payment method')).toContain('>Add a card<');
  });

  it('draws the page around a slow or failed read', () => {
    answers.byPath.set('/workspaces/ada/billing', { loading: true });
    expect(render(BillingSettings, { workspace: 'ada' })).toContain('Loading billing');
    expect(render(BillingSettings, { workspace: 'ada' })).toContain('Every platform feature');
    answers.byPath.set('/workspaces/ada/billing', { error: 'boom' });
    expect(render(BillingSettings, { workspace: 'ada' })).toContain('Retry');
  });

  it('shows the card by brand and last four, top-ups, the rule and the failure banner', () => {
    answers.byPath.set('/workspaces/ada/billing', {
      data: billing({
        credit: credit({
          card,
          promo: { usd: 100, granted: true },
          top_up_failed: 'card declined',
        }),
        payment_method: card,
        top_ups: [
          {
            id: 't1',
            amount_usd: 20,
            status: 'succeeded',
            error: null,
            created_at: Date.UTC(2026, 9, 29),
          },
          {
            id: 't2',
            amount_usd: 20,
            status: 'failed',
            error: 'card declined',
            created_at: Date.UTC(2026, 9, 30),
          },
        ],
      }),
    });
    const html = render(BillingSettings, { workspace: 'ada' });
    expect(html).toContain('Visa •••• 4242');
    expect(html).not.toMatch(/\b4242424242424242\b/);
    expect(html).toContain('Auto top-up: $20.00 when the balance falls below $5.00');
    expect(html).toContain('Replace card');
    expect(html).toContain('Remove card');
    expect(html).toContain('role="alert"');
    expect(html).toContain('The last automatic top-up failed (card declined)');
    expect(html).toContain('<td>2026-10-29</td><td>$20.00</td>');
    expect(html).toContain('>Added<');
    expect(html).toContain('>Failed<');
    expect(html).not.toContain('Adding a card unlocks');
  });

  it('switches automatic top-up off without removing the card, and says how to stop paying', () => {
    const withCard = { credit: credit({ card }), payment_method: card };
    answers.byPath.set('/workspaces/ada/billing', { data: billing(withCard) });
    const on = render(BillingSettings, { workspace: 'ada' });
    expect(on).toMatch(/type="checkbox" role="switch" aria-checked="true" checked=""/);
    expect(on).toContain('Automatic top-up');
    expect(on).toContain(
      'To stop all charges: turn off automatic top-up or remove your card. Agents keep running on your remaining credit, then pause. Pause or archive agents on the Agents page.',
    );
    answers.byPath.set('/workspaces/ada/billing', {
      data: billing({ ...withCard, auto_top_up: { below_usd: 5, add_usd: 20, enabled: false } }),
    });
    const off = render(BillingSettings, { workspace: 'ada' });
    expect(off).toMatch(/type="checkbox" role="switch" aria-checked="false"/);
    expect(off).not.toContain('checked=""');
    expect(off).toContain('Your card is not charged');
    expect(off).toContain('Visa •••• 4242');
  });
});

describe('the Agents page credit card', () => {
  it('without a card: starting credit and the offer to unlock the promotional credit', () => {
    const html = render(PromoCard, { workspace: 'ada', credit: credit(), billing: 'stripe' });
    expect(html).toContain('This one is on us!');
    expect(html).toContain('when you set up your first agent');
    expect(html).toContain('$0.30 used');
    expect(html).toMatch(/<button type="button">Add a card to unlock \$100\.00<\/button>/);
    expect(render(PromoCard, { workspace: 'ada', credit: credit(), billing: 'coming' })).toMatch(
      /disabled="" title="Card billing is coming">Card billing is coming/,
    );
  });

  it('with a card: balance, the top-up rule and the card, and a failed top-up', () => {
    const html = render(PromoCard, {
      workspace: 'ada',
      credit: credit({
        card,
        balance_usd: 104.2,
        promo: { usd: 100, granted: true },
        top_up_failed: 'declined',
      }),
      billing: 'stripe',
      manageHref: '/settings/billing',
    });
    expect(html).toContain('Agent credit');
    expect(html).toContain('$104.20');
    expect(html).toContain('Visa •••• 4242 · Auto top-up on · ');
    expect(html).toContain('<a href="/settings/billing">Manage billing</a>');
    expect(html).toContain('The last top-up failed');
    expect(html).not.toContain('Add a card');
    // Switched off: the card says so, and no "Manage billing" where Settings is not this
    // workspace's billing (an org).
    const off = render(PromoCard, {
      workspace: 'acme',
      credit: credit({ card, auto_top_up: false }),
      billing: 'stripe',
    });
    expect(off).toContain('Visa •••• 4242 · Auto top-up off');
    expect(off).not.toContain('Manage billing');
  });

  it('back from Stripe: says the card was saved, with the promotional credit only when granted', () => {
    const saved = render(PromoCard, {
      workspace: 'ada',
      credit: credit({ card, promo: { usd: 100, granted: true } }),
      billing: 'stripe',
      manageHref: '/settings/billing',
      saving: 'saved',
    });
    expect(saved).toContain('role="status"');
    expect(saved).toContain('Card saved. $100.00 promotional credit added.');
    const plain = render(PromoCard, {
      workspace: 'ada',
      credit: credit({ card }),
      billing: 'stripe',
      saving: 'saved',
    });
    expect(plain).toContain('Card saved.');
    expect(plain).not.toContain('promotional credit added');
    expect(
      render(PromoCard, {
        workspace: 'ada',
        credit: credit(),
        billing: 'stripe',
        saving: 'waiting',
      }),
    ).toContain('Saving your card…');
  });
});
