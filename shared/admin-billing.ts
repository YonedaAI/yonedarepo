// What the operators' billing routes answer (`/api/v1/admin/accounts/:account/billing`), read
// by the admin pages. Amounts are USD. Card data is the brand and last four, never more.
import type { CardOnFile, TopUp } from './managed-agents';

export interface Paged<T> {
  items: T[];
  next: number | null;
}

/** A top-up and what is left of it. */
export interface AdminTopUp {
  id: string;
  amount_usd: number;
  status: TopUp['status'];
  error: string | null;
  created_at: number;
  /** The Stripe payment intent, once charged. */
  payment_intent: string | null;
  /** Taken by refunds, open ones included. */
  refunded_usd: number;
  /** Frozen by disputes: open ones, and lost ones, whose credit never comes back. */
  frozen_usd: number;
  /** Still on the balance: the most a refund takes without the spent-credit override. */
  unspent_usd: number;
  /** The most Stripe can still refund of this top-up. */
  refundable_usd: number;
  /** A dispute is open on it: no refund until it closes. */
  disputed: boolean;
}

export interface AdminRefund {
  id: string;
  top_up: string;
  amount_usd: number;
  /** `open`: the credit is taken and Stripe has not confirmed; a retry is scheduled. */
  status: 'open' | 'succeeded' | 'failed';
  /** `operator`: from these pages. `stripe`: made in Stripe's dashboard. */
  origin: 'operator' | 'stripe';
  actor: string;
  reason: string;
  spent_override: boolean;
  stripe_refund: string | null;
  error: string | null;
  created_at: number;
  settled_at: number | null;
}

export interface AdminDispute {
  id: string;
  top_up: string | null;
  charge: string;
  amount_usd: number;
  frozen_usd: number;
  /** `open`, or how Stripe closed it (`won`, `lost`, `warning_closed`, `prevented`). */
  status: string;
  reason: string | null;
  opened_at: number;
  closed_at: number | null;
}

export interface AdminBilling {
  workspace: string;
  balance: { granted_usd: number; used_usd: number; balance_usd: number };
  customer: string | null;
  /** The customer in Stripe's dashboard. */
  stripe_url: string | null;
  card: CardOnFile | null;
  auto_top_up: boolean;
  top_up_failed: string | null;
  /** An operator's pause on charging the card. */
  paused: { at: number; reason: string | null; by: string | null } | null;
  top_ups: AdminTopUp[];
  refunds: AdminRefund[];
  disputes: AdminDispute[];
  /** Whether refunds can go out here, and today's limits (null: refused until set). */
  refund: {
    configured: boolean;
    max_usd: number | null;
    daily_usd: number | null;
    used_today_usd: number;
  };
}

export interface AdminLedgerEntry {
  id: number;
  at: number;
  /** `grant`, `hold`, `release`, `charge`, `refund`, `refund-reversal`, `freeze`, `unfreeze`. */
  kind: string;
  amount_usd: number;
  repo: string | null;
  run: string | null;
  agent: string | null;
  model: string | null;
  note: string | null;
}

export interface AdminRunUsage {
  run: string;
  repo: string | null;
  agent: string | null;
  at: number;
  calls: number;
  charged_usd: number;
  input_tokens: number;
  output_tokens: number;
}
