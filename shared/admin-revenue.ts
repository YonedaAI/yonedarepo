// What `/api/v1/admin/revenue` answers, read by the admin pages. Amounts are USD, and a null cost
// or margin means the ledger recorded none. Imports nothing: the platform Worker serves this and
// must not reach the agent layer's types through it.

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
