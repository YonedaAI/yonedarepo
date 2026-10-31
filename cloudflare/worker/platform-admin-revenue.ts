// `/api/v1/admin/revenue`: platform-wide money for operators, behind `ADMIN_BILLING`, read from
// the D1 rollup each ledger pushes to (managed/ledger-rollup.ts), so a page load wakes no ledger.
// Everything here is the ledger's account of things: the nightly reconcile holds the ledger to
// Stripe and the rollup to the ledger, and logs what differs.
//
// Nothing is estimated. Net revenue is money kept, before Stripe's fees, which are not recorded;
// so it is not profit and is not called that. Credit sold and unused is a liability, kept apart.
// A cost is shown only where the ledger recorded one: a model call's, at list rates.
import type { AdminRevenue } from '../../shared/admin-billing';
import { managed } from './platform-admin-billing';
import { audit } from './platform-admin-queries';
import { ApiError, type Json } from './repo-ops';
import type { Env } from './types';

const DAY_MS = 86_400_000;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const DEFAULT_DAYS = 30;
/** A longer range goes by month: a table of more days is not read. */
const MAX_DAYS = 366;
const TOP_ACCOUNTS = 10;
const REBUILD_PAGE = 100;

const usd = (micro: number | null | undefined) => (micro ?? 0) / 1_000_000;
const utcDay = (at: number) => new Date(at).toISOString().slice(0, 10);

/** A real calendar date, as its time; null otherwise (`2026-13-01`, `2026-02-30`). */
function dayTime(value: string) {
  const at = Date.parse(`${value}T00:00:00Z`);
  return DAY.test(value) && !Number.isNaN(at) && utcDay(at) === value ? at : null;
}

function rangeOf(query: URLSearchParams, now = Date.now()) {
  const by = query.get('by') ?? 'day';
  if (by !== 'day' && by !== 'month') throw new ApiError('INVALID_INPUT', 'by is day or month');
  const given = [query.get('from'), query.get('to')];
  if (given[0] === null && given[1] === null) {
    const to = utcDay(now);
    return { from: utcDay(now - (DEFAULT_DAYS - 1) * DAY_MS), to, by } as const;
  }
  const [from, to] = given.map((d) => dayTime(d ?? ''));
  if (from === null || to === null) throw new ApiError('INVALID_INPUT', 'from and to are dates');
  if (from > to) throw new ApiError('INVALID_INPUT', 'from is after to');
  if (by === 'day' && (to - from) / DAY_MS >= MAX_DAYS)
    throw new ApiError('INVALID_INPUT', `By day covers up to ${MAX_DAYS} days: use by month`);
  return { from: utcDay(from), to: utcDay(to), by } as const;
}

const CONSUMED = 'model_charged+container_charged+unpriced_charged';
const SUMS = `SUM(top_ups) AS top_ups,SUM(refunds) AS refunds,SUM(disputes_lost) AS disputes_lost,
  SUM(free_granted) AS free_granted,SUM(model_charged) AS model_charged,
  SUM(model_cost) AS model_cost,SUM(container_charged) AS container_charged,
  SUM(unpriced_charged) AS unpriced_charged,SUM(${CONSUMED}) AS consumed`;
const IN_RANGE = 'day>=? AND day<=?';

function money(row: Json | undefined) {
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

function usage(row: Json | undefined): AdminRevenue['usage'] {
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

/** `GET revenue?from=&to=&by=`: one consistent read of the rollup. */
export async function revenue(env: Env, query: URLSearchParams): Promise<AdminRevenue> {
  const { from, to, by } = rangeOf(query);
  const period = by === 'month' ? 'substr(day,1,7)' : 'day';
  const db = env.INDEX;
  const [periods, totals, top, paying, active, position] = await db.batch<Json>([
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

/** `POST revenue/rebuild {after}`: one page of accounts, personal and those that own repositories
 * (an org is a billed account too), asked to push their ledgers again. It wakes each of them, so
 * it is for the first use and for repairs, never for a page load. */
export async function rebuildRollup(env: Env, actor: string, body: Json) {
  const after = typeof body.after === 'string' ? body.after : '';
  const { results } = await env.INDEX.prepare(
    `SELECT account FROM (SELECT account FROM platform_accounts
       UNION SELECT workspace AS account FROM platform_repos)
     WHERE account>? ORDER BY account LIMIT ?`,
  )
    .bind(after, REBUILD_PAGE)
    .all<{ account: string }>();
  const accounts = results.map((r) => r.account);
  if (accounts.length) await managed(env, 'POST', '/admin/billing/rollup', { accounts });
  const answer = {
    queued: accounts.length,
    next: accounts.length === REBUILD_PAGE ? (accounts.at(-1) ?? null) : null,
  };
  await audit(env, actor, 'billing.rollup_rebuild', after || '-', answer);
  return answer;
}
