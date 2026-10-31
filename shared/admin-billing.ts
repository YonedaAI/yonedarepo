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

/** Money in and out over a period. All of it comes from the ledger, not from Stripe. */
export interface AdminRevenueMoney {
  gross_top_ups_usd: number;
  /** Refunds Stripe confirmed, the dashboard's included. */
  refunds_usd: number;
  /** The money lost disputes took, which can be more than the credit they froze. */
  disputes_lost_usd: number;
  /** Gross less refunds and disputes lost, before Stripe's fees, which are not recorded. */
  net_revenue_usd: number;
}

/** Credit charged. A null cost or margin was not recorded, and must read as that. */
export interface AdminRevenueUsage {
  charged_usd: number;
  cost_usd: number | null;
  margin_usd: number | null;
}

/** `GET /api/v1/admin/revenue`. */
export interface AdminRevenue {
  from: string;
  to: string;
  by: 'day' | 'month';
  source: 'ledger';
  totals: AdminRevenueMoney;
  /** Newest first. */
  periods: (AdminRevenueMoney & { period: string; consumed_usd: number })[];
  /** Each account's position now, whatever the range. A liability, not revenue. */
  outstanding: {
    /** The latest push from any ledger; null with nothing recorded. */
    as_of: number | null;
    accounts: number;
    /** Credit customers paid for and have not used. */
    sold_usd: number;
    /** Credit given away and unused: no money was taken for it. */
    free_usd: number;
    /** Credit frozen by open disputes. */
    frozen_usd: number;
    /** Refunds recorded, with their credit taken, that Stripe has not confirmed. */
    refunds_open_usd: number;
  };
  usage: {
    /** Every charge: all three kinds below. Includes credit that was given away. */
    consumed_usd: number;
    free_granted_usd: number;
    /** Model calls with the provider's usage. Cost is that usage at list rates, not an invoice. */
    model: AdminRevenueUsage & { cost_usd: number; margin_usd: number; markup: number | null };
    /** Container time, at a flat rate: what the containers cost is not recorded. */
    container: AdminRevenueUsage;
    /** Calls whose outcome is unknown, charged their whole hold. */
    unpriced: AdminRevenueUsage;
  };
  /** Not in the ledger. */
  stripe_fees_usd: null;
  accounts: {
    /** Accounts with a top-up in the range. */
    paying: number;
    /** Accounts that have paid at some point and used credit in the range. */
    active_paying: number;
    top: { account: string; gross_usd: number; net_usd: number }[];
  };
}
