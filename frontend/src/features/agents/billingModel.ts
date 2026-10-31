// Agent billing as the pages print it (`/api/managed/workspaces/:ws/billing`,
// shared/managed-agents.ts): the promotional credit a card unlocks, the saved card (brand and
// last four only), the automatic top-up rule and whether it is on, top-ups, and where Stripe
// sends the browser back.
// Card details never reach the browser: adding a card is Stripe's own page.
import type {
  BillingMode,
  CardOnFile,
  ManagedCredit,
  TopUp,
} from '../../../../shared/managed-agents';
import { formatSourceRoute } from '../source-platform/sourceRoute';
import { formatCost } from './agentsModel';

const ws = (workspace: string) => `/workspaces/${encodeURIComponent(workspace)}`;
export const setupPath = (workspace: string) => `${ws(workspace)}/billing/setup`;
export const removeCardPath = (workspace: string) => `${ws(workspace)}/billing/card/remove`;
export const autoTopUpPath = (workspace: string) => `${ws(workspace)}/billing/auto-top-up`;

/** Where Stripe sends the browser back to Settings → Billing once the card is saved. */
export const RETURN_PATH = formatSourceRoute({
  view: 'settings',
  section: 'billing',
  cardAdded: true,
});
/** Where Stripe sends the browser back to the Agents page (an org's keeps `?workspace=`). */
export const agentsReturnPath = (workspace?: string) =>
  formatSourceRoute({ view: 'agents-home', ...(workspace ? { workspace } : {}), cardAdded: true });

const BRANDS: Record<string, string> = {
  visa: 'Visa',
  mastercard: 'Mastercard',
  amex: 'American Express',
  discover: 'Discover',
  jcb: 'JCB',
  diners: 'Diners Club',
  unionpay: 'UnionPay',
};

/** `Visa •••• 4242`. */
export function cardLabel(card: Pick<CardOnFile, 'brand' | 'last4'>): string {
  const brand = BRANDS[card.brand.toLowerCase()] ?? (card.brand ? card.brand : 'Card');
  return `${brand} •••• ${card.last4}`;
}

/** `Auto top-up: $20 when the balance falls below $5`. */
export const topUpRule = (rule: { below_usd: number; add_usd: number }) =>
  `Auto top-up: ${formatCost(rule.add_usd)} when the balance falls below ${formatCost(rule.below_usd)}`;

/** `Visa •••• 4242 · Auto top-up on`: the Agents page's line for a saved card, else null. */
export const cardSummary = (credit: ManagedCredit) =>
  credit.card
    ? `${cardLabel(credit.card)} · Auto top-up ${credit.auto_top_up ? 'on' : 'off'}`
    : null;

/** What the promotional credit card says, for a workspace with or without a card. */
export function promoCopy(credit: ManagedCredit, billing: BillingMode) {
  if (credit.card) {
    const draw = credit.auto_top_up
      ? 'Runs draw from your credit, and it tops up from your card when it runs low.'
      : 'Runs draw from your credit. Automatic top-up is off, so runs pause when it runs out.';
    return {
      title: 'Agent credit',
      body: credit.promo.granted
        ? `Your card unlocked ${formatCost(credit.promo.usd)} of promotional credit. ${draw}`
        : draw,
    };
  }
  return {
    title: 'This one is on us!',
    body: `YonedaRepo adds ${formatCost(credit.granted_usd)} of starting credit when you set up your first agent. Add a card to unlock ${formatCost(credit.promo.usd)} more.`,
    action:
      billing === 'stripe'
        ? `Add a card to unlock ${formatCost(credit.promo.usd)}`
        : 'Card billing is coming',
  };
}

const TOP_UP_LABELS: Record<TopUp['status'], string> = {
  pending: 'Charging',
  succeeded: 'Added',
  failed: 'Failed',
};
export const topUpStatusLabel = (status: TopUp['status']) => TOP_UP_LABELS[status] ?? status;
export const topUpTone = (status: TopUp['status']) =>
  status === 'succeeded' ? 'good' : status === 'failed' ? 'bad' : 'neutral';

/** `2026-10-30`: a top-up's day, in UTC. */
export const topUpDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** The banner shown when the last automatic top-up failed. */
export const topUpFailedText = (reason: string) =>
  `The last automatic top-up failed (${reason}). Agent runs stop when your credit runs out; update your card to keep them going.`;

/** After returning from Stripe: the card is saved once the billing answer shows one. The
 * webhook that records it may land a moment later, so the page re-reads a few times. */
export function cardSaveState(returned: boolean, card: CardOnFile | null, tries: number) {
  if (!returned) return 'none' as const;
  if (card) return 'saved' as const;
  return tries >= 5 ? ('late' as const) : ('waiting' as const);
}
export type CardSaveState = ReturnType<typeof cardSaveState>;

/** The confirmation once the card shows, naming the promotional credit only once granted. */
export const cardSavedText = (credit: Pick<ManagedCredit, 'promo'>) =>
  credit.promo.granted
    ? `Card saved. ${formatCost(credit.promo.usd)} promotional credit added.`
    : 'Card saved.';
