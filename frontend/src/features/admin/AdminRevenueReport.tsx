// What one read of the revenue rollup shows. Every figure is the ledger's. Net revenue is money
// kept before Stripe's fees, which the ledger does not hold, so it is called nothing stronger.
// Sold credit is a liability and stands apart from it. A cost nobody recorded reads "not
// recorded", never a guess.
import type { AdminRevenue, AdminRevenueUsage } from '../../../../shared/admin-billing';
import { linkTo, type Navigate } from '../shell/useRoute';
import { money } from './adminBillingModel';
import { when } from './adminModel';
import { recorded } from './adminRevenueModel';

function Figure({ usd }: { usd: number | null }) {
  return usd === null ? <span className="admin-unrecorded">{recorded(usd)}</span> : recorded(usd);
}

function Tiles({ report }: { report: AdminRevenue }) {
  const { totals } = report;
  const tiles = [
    { label: 'Gross top-ups', usd: totals.gross_top_ups_usd, caption: 'charged to cards' },
    { label: 'Refunds', usd: totals.refunds_usd, caption: 'confirmed by Stripe' },
    { label: 'Disputes lost', usd: totals.disputes_lost_usd, caption: 'money taken back' },
    {
      label: 'Net revenue',
      usd: totals.net_revenue_usd,
      caption: 'before Stripe fees, unused credit included',
    },
  ];
  return (
    <ul className="stat-cards admin-tiles">
      {tiles.map((tile) => (
        <li key={tile.label} className="stat-card">
          <span className="stat-label">{tile.label}</span>
          <span className="stat-value">{money(tile.usd)}</span>
          <span className="stat-caption">{tile.caption}</span>
        </li>
      ))}
    </ul>
  );
}

function Periods({ report }: { report: AdminRevenue }) {
  if (!report.periods.length)
    return (
      <p className="source-empty">
        Nothing recorded in this range. If this is the first use here, rebuild from the ledgers.
      </p>
    );
  return (
    <div className="source-table-wrap">
      <table className="source-table admin-table">
        <thead>
          <tr>
            <th>{report.by === 'month' ? 'Month' : 'Day (UTC)'}</th>
            <th>Gross top-ups</th>
            <th>Refunds</th>
            <th>Disputes lost</th>
            <th>Net revenue</th>
            <th>Credit consumed</th>
          </tr>
        </thead>
        <tbody>
          {report.periods.map((p) => (
            <tr key={p.period}>
              <td>{p.period}</td>
              <td>{money(p.gross_top_ups_usd)}</td>
              <td>{money(p.refunds_usd)}</td>
              <td>{money(p.disputes_lost_usd)}</td>
              <td>{money(p.net_revenue_usd)}</td>
              <td>{money(p.consumed_usd)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Outstanding({ report }: { report: AdminRevenue }) {
  const { outstanding: o } = report;
  return (
    <>
      <h3 className="home-label">Credit outstanding</h3>
      <p className="source-meta">
        A liability, not revenue: what we still owe in agent use, across {o.accounts} accounts.
        These are positions now, whatever the range above.
        {o.as_of ? ` Latest update ${when(o.as_of)}.` : ''}
      </p>
      <dl className="admin-facts">
        <dt>Sold, unspent</dt>
        <dd>{money(o.sold_usd)}</dd>
        <dt>Frozen by open disputes</dt>
        <dd>{money(o.frozen_usd)}</dd>
        <dt>Refunds awaiting Stripe</dt>
        <dd>{money(o.refunds_open_usd)}</dd>
        <dt>Free credit, unspent</dt>
        <dd>
          {money(o.free_usd)}
          <span className="admin-sub">given away, not sold: no money was taken for it</span>
        </dd>
      </dl>
    </>
  );
}

function UsageRow({ label, row }: { label: string; row: AdminRevenueUsage }) {
  return (
    <tr>
      <td>{label}</td>
      <td>{money(row.charged_usd)}</td>
      <td>
        <Figure usd={row.cost_usd} />
      </td>
      <td>
        <Figure usd={row.margin_usd} />
      </td>
    </tr>
  );
}

function Usage({ report }: { report: AdminRevenue }) {
  const { usage, stripe_fees_usd: fees } = report;
  return (
    <>
      <h3 className="home-label">Usage</h3>
      <div className="source-table-wrap">
        <table className="source-table admin-table">
          <thead>
            <tr>
              <th>Charged for</th>
              <th>Credit consumed</th>
              <th>Our cost</th>
              <th>Margin</th>
            </tr>
          </thead>
          <tbody>
            <UsageRow label="Model calls" row={usage.model} />
            <UsageRow label="Container time" row={usage.container} />
            <UsageRow label="Calls with an unknown outcome" row={usage.unpriced} />
            <tr>
              <td>All usage</td>
              <td>{money(usage.consumed_usd)}</td>
              <td>
                <Figure usd={null} />
              </td>
              <td>
                <Figure usd={null} />
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <p className="source-meta">
        Model cost is the provider's reported usage at list rates, not an invoice
        {usage.model.markup === null ? '' : `, marked up ${usage.model.markup} times`}. Usage
        includes credit we gave away: {money(usage.free_granted_usd)} was granted free in this
        range. Stripe fees: <Figure usd={fees} />, so nothing here is after fees.
      </p>
    </>
  );
}

function Accounts({ report, navigate }: { report: AdminRevenue; navigate: Navigate }) {
  const { accounts } = report;
  return (
    <>
      <h3 className="home-label">Accounts</h3>
      <dl className="admin-facts">
        <dt>Paying</dt>
        <dd>
          {accounts.paying}
          <span className="admin-sub">a top-up in this range</span>
        </dd>
        <dt>Active paying</dt>
        <dd>
          {accounts.active_paying}
          <span className="admin-sub">have paid, and used credit in this range</span>
        </dd>
      </dl>
      {accounts.top.length ? (
        <div className="source-table-wrap">
          <table className="source-table admin-table">
            <thead>
              <tr>
                <th>Top paying accounts</th>
                <th>Gross top-ups</th>
                <th>Net</th>
              </tr>
            </thead>
            <tbody>
              {accounts.top.map((a) => (
                <tr key={a.account}>
                  <td>
                    <a
                      {...linkTo({ view: 'admin', section: 'users', account: a.account }, navigate)}
                    >
                      {a.account}
                    </a>
                  </td>
                  <td>{money(a.gross_usd)}</td>
                  <td>{money(a.net_usd)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="source-empty">No paying accounts in this range.</p>
      )}
    </>
  );
}

/** What one read of the rollup shows. */
export function RevenueReport({ report, navigate }: { report: AdminRevenue; navigate: Navigate }) {
  return (
    <>
      <p className="source-meta">
        Ledger amounts, by UTC day. The nightly reconcile compares the ledger with Stripe and the
        figures here with the ledger, and logs any difference.
      </p>
      <Tiles report={report} />
      <Periods report={report} />
      <Outstanding report={report} />
      <Usage report={report} />
      <Accounts report={report} navigate={navigate} />
    </>
  );
}
