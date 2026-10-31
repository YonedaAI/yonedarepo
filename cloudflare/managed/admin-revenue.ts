// Platform-wide money for operators, from the rollup each ledger pushes to this Worker's own D1
// (ledger-rollup.ts), so a read wakes no ledger. The platform Worker's admin route asks for this
// with the admin bearer, as it asks for credit. Everything here is the ledger's account of
// things: the nightly reconcile holds the ledger to Stripe and the rollup to the ledger, and logs
// what differs.
//
// Nothing is estimated. Net revenue is money kept, before Stripe's fees, which are not recorded;
// so it is not profit and is not called that. Credit sold and unused is a liability, kept apart.
// A cost is shown only where the ledger recorded one: a model call's, at list rates.
import type { AdminRevenue } from '../../shared/admin-revenue';
import { BillingRefusal } from './billing';
import type { ManagedEnv } from './config';

type Row = Record<string, any>;

const invalid = (message: string) => new BillingRefusal('INVALID_INPUT', message, 400);

const DAY_MS = 86_400_000;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const DEFAULT_DAYS = 30;
/** A longer range goes by month: a table of more days is not read. */
const MAX_DAYS = 366;
const TOP_ACCOUNTS = 10;

const usd = (micro: number | null | undefined) => (micro ?? 0) / 1_000_000;
const utcDay = (at: number) => new Date(at).toISOString().slice(0, 10);

/** A real calendar date, as its time; null otherwise (`2026-13-01`, `2026-02-30`). */
function dayTime(value: string) {
  const at = Date.parse(`${value}T00:00:00Z`);
  return DAY.test(value) && !Number.isNaN(at) && utcDay(at) === value ? at : null;
}

function rangeOf(query: URLSearchParams, now = Date.now()) {
  const by = query.get('by') ?? 'day';
  if (by !== 'day' && by !== 'month') throw invalid('by is day or month');
  const given = [query.get('from'), query.get('to')];
  if (given[0] === null && given[1] === null) {
    const to = utcDay(now);
    return { from: utcDay(now - (DEFAULT_DAYS - 1) * DAY_MS), to, by } as const;
  }
  const [from, to] = given.map((d) => dayTime(d ?? ''));
  if (from === null || to === null) throw invalid('from and to are dates');
  if (from > to) throw invalid('from is after to');
  if (by === 'day' && (to - from) / DAY_MS >= MAX_DAYS)
    throw invalid(`By day covers up to ${MAX_DAYS} days: use by month`);
  return { from: utcDay(from), to: utcDay(to), by } as const;
}

const CONSUMED = 'model_charged+container_charged+unpriced_charged';
const SUMS = `SUM(top_ups) AS top_ups,SUM(refunds) AS refunds,SUM(disputes_lost) AS disputes_lost,
  SUM(free_granted) AS free_granted,SUM(model_charged) AS model_charged,
  SUM(model_cost) AS model_cost,SUM(container_charged) AS container_charged,
  SUM(unpriced_charged) AS unpriced_charged,SUM(${CONSUMED}) AS consumed`;
const IN_RANGE = 'day>=? AND day<=?';

function money(row: Row | undefined) {
  const [gross, refunds, lost] = [row?.top_ups, row?.refunds, row?.disputes_lost].map(usd);
  return {
    gross_top_ups_usd: gross,
    refunds_usd: refunds,
    disputes_lost_usd: lost,
    net_revenue_usd: usd((row?.top_ups ?? 0) - (row?.refunds ?? 0) - (row?.disputes_lost ?? 0)),
  };
}

/** Charged credit with no recorded cost: there is no margin to give. */
const unrecorded = (charged: number) => ({
  charged_usd: usd(charged),
  cost_usd: null,
  margin_usd: null,
});

function usage(row: Row | undefined): AdminRevenue['usage'] {
  const charged = row?.model_charged ?? 0;
  const cost = row?.model_cost ?? 0;
  return {
    consumed_usd: usd(row?.consumed),
    free_granted_usd: usd(row?.free_granted),
    model: {
      charged_usd: usd(charged),
      cost_usd: usd(cost),
      margin_usd: usd(charged - cost),
      markup: cost > 0 ? Math.round((charged / cost) * 1000) / 1000 : null,
    },
    container: unrecorded(row?.container_charged ?? 0),
    unpriced: unrecorded(row?.unpriced_charged ?? 0),
  };
}

/** `GET /admin/billing/revenue?from=&to=&by=`: one consistent read of the rollup. */
export async function revenue(env: ManagedEnv, query: URLSearchParams): Promise<AdminRevenue> {
  const db = env.REVENUE;
  if (!db) throw new BillingRefusal('NOT_CONFIGURED', 'Revenue is not set up here', 503);
  const { from, to, by } = rangeOf(query);
  const period = by === 'month' ? 'substr(day,1,7)' : 'day';
  const [periods, totals, top, paying, active, position] = await db.batch<Row>([
    db
      .prepare(
        `SELECT ${period} AS period,${SUMS} FROM billing_daily WHERE ${IN_RANGE}
         GROUP BY period ORDER BY period DESC`,
      )
      .bind(from, to),
    db.prepare(`SELECT ${SUMS} FROM billing_daily WHERE ${IN_RANGE}`).bind(from, to),
    db
      .prepare(
        `SELECT account,SUM(top_ups) AS gross,SUM(top_ups-refunds-disputes_lost) AS net
         FROM billing_daily WHERE ${IN_RANGE} GROUP BY account HAVING gross>0
         ORDER BY net DESC,account LIMIT ?`,
      )
      .bind(from, to, TOP_ACCOUNTS),
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM (SELECT account FROM billing_daily WHERE ${IN_RANGE}
         GROUP BY account HAVING SUM(top_ups)>0)`,
      )
      .bind(from, to),
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM (SELECT d.account FROM billing_daily d
         JOIN billing_accounts a ON a.account=d.account
         WHERE d.day>=? AND d.day<=? AND a.first_paid_day<=?
         GROUP BY d.account HAVING SUM(${CONSUMED})>0)`,
      )
      .bind(from, to, to),
    db.prepare(
      `SELECT COUNT(*) AS accounts,MAX(updated_at) AS as_of,SUM(sold_outstanding) AS sold,
         SUM(free_outstanding) AS free,SUM(frozen) AS frozen,SUM(refunds_open) AS refunds_open
       FROM billing_accounts`,
    ),
  ]);
  const held = position.results[0];
  return {
    from,
    to,
    by,
    source: 'ledger',
    totals: money(totals.results[0]),
    periods: periods.results.map((row) => ({
      period: String(row.period),
      ...money(row),
      consumed_usd: usd(row.consumed),
    })),
    outstanding: {
      as_of: held?.as_of ?? null,
      accounts: held?.accounts ?? 0,
      sold_usd: usd(held?.sold),
      free_usd: usd(held?.free),
      frozen_usd: usd(held?.frozen),
      refunds_open_usd: usd(held?.refunds_open),
    },
    usage: usage(totals.results[0]),
    stripe_fees_usd: null,
    accounts: {
      paying: paying.results[0]?.n ?? 0,
      active_paying: active.results[0]?.n ?? 0,
      top: top.results.map((row) => ({
        account: String(row.account),
        gross_usd: usd(row.gross),
        net_usd: usd(row.net),
      })),
    },
  };
}
