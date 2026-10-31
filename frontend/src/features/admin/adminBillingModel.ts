// The Billing section's model: its paths, and what a refund or an action would do, worked out
// before anything is sent so the operator sees it first. The server decides again for itself.
import type { AdminRefund, AdminTopUp } from '../../../../shared/admin-billing';
import { accountPath, withQuery } from './adminModel';

export const billingPath = (account: string) => `${accountPath(account)}/billing`;
export const ledgerPath = (account: string, before?: number) =>
  withQuery(`${billingPath(account)}/ledger`, { before });
export const usagePath = (account: string, before?: number) =>
  withQuery(`${billingPath(account)}/usage`, { before });

export const money = (usd: number) => `${usd < 0 ? '-' : ''}$${Math.abs(usd).toFixed(2)}`;

const cents = (usd: number) => Math.round(usd * 100);

/** A form's starting amount: the unspent credit, else all that can be refunded, in whole cents
 * rounded down. */
export function defaultRefund(topUp: AdminTopUp) {
  const usd = topUp.unspent_usd > 0 ? topUp.unspent_usd : topUp.refundable_usd;
  return (Math.floor(usd * 100 + 1e-6) / 100).toFixed(2);
}

export type RefundPlan = {
  amount: number;
  /** Why it would be refused; null when it can be sent. */
  problem: string | null;
  /** How much of it is credit already spent (needs the override). */
  spent: number;
  /** The balance after it. */
  after: number;
  negative: boolean;
};

function refundProblem(topUp: AdminTopUp, text: string, amount: number, max?: number | null) {
  if (!text.trim() || !Number.isFinite(amount) || amount <= 0) return 'Enter an amount.';
  if (Math.abs(amount * 100 - cents(amount)) > 1e-6) return 'Use whole cents.';
  if (amount > topUp.refundable_usd)
    return `At most ${money(topUp.refundable_usd)} can be refunded.`;
  if (max !== undefined && max !== null && amount > max)
    return `Over the limit of ${money(max)} per refund.`;
  return null;
}

export function refundPlan(
  topUp: AdminTopUp,
  balance: number,
  text: string,
  max?: number | null,
): RefundPlan {
  const amount = Number(text);
  const problem = refundProblem(topUp, text, amount, max);
  const spent = Math.max(0, cents(amount || 0) - Math.round(topUp.unspent_usd * 100)) / 100;
  const after = (cents(balance) - cents(amount || 0)) / 100;
  return { amount: amount || 0, problem, spent, after, negative: after < 0 };
}

export const refundConfirm = (name: string, topUp: AdminTopUp, amount: number) =>
  `Refund ${money(amount)} of ${topUp.id} to ${name}? Stripe returns it to the card that paid, and the ledger debits it.`;

export function refundResult(refund: Pick<AdminRefund, 'status' | 'amount_usd'>) {
  if (refund.status === 'succeeded') return `Refunded ${money(refund.amount_usd)}.`;
  return `${money(refund.amount_usd)} is recorded and its credit taken. Stripe has not confirmed yet; it is retried until it settles.`;
}

export type BillingAction =
  | { kind: 'credit' }
  | { kind: 'auto-top-up-off' }
  | { kind: 'remove-card' }
  | { kind: 'pause'; paused: boolean };

export function actionConfirm(action: BillingAction, name: string, amount: string) {
  switch (action.kind) {
    case 'credit':
      return `Grant ${name} ${money(Number(amount))} of goodwill credit?`;
    case 'auto-top-up-off':
      return `Turn off automatic top-up for ${name}? The card stays saved.`;
    case 'remove-card':
      return `Remove ${name}'s card? It is detached at Stripe and top-ups stop.`;
    case 'pause':
      return action.paused
        ? `Pause billing for ${name}? Their card is not charged until you resume. Credit they already have stays usable.`
        : `Resume billing for ${name}? Their card can be charged again.`;
  }
}

export const ACTION_LABEL: Record<BillingAction['kind'], string> = {
  credit: 'Goodwill credit',
  'auto-top-up-off': 'Turn off auto top-up',
  'remove-card': 'Remove card',
  pause: 'Pause billing',
};

/** A new id per attempt: the same id is the same refund, so a retry can't refund twice. */
export const requestId = () => crypto.randomUUID();
