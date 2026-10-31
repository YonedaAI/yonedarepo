// What one read of the revenue rollup shows. Every figure is the ledger's. Net revenue is money
// kept before Stripe's fees, which the ledger does not hold, so it is called nothing stronger.
// Sold credit is a liability and stands apart from it. A cost nobody recorded reads "not
// recorded", never a guess.
import type { AdminRevenue, AdminRevenueUsage } from '../../../../shared/admin-revenue';
import { linkTo, type Navigate } from '../shell/useRoute';
import { money } from './adminBillingModel';
import { when } from './adminModel';
import { recorded } from './adminRevenueModel';

function Figure({ usd }: { usd: number | null }) {
  return usd === null ? <span className="admin-unrecorded">{recorded(usd)}</span> : recorded(usd);
}

/** The takings as the sum they are: gross, less refunds and disputes, is net. */
function Takings({ report }: { report: AdminRevenue }) {
  const { totals } = report;
  const steps = [
    { op: '', label: 'Gross top-ups', usd: totals.gross_top_ups_usd, caption: 'charged to cards' },
    { op: '−', label: 'Refunds', usd: totals.refunds_usd, caption: 'confirmed by Stripe' },
    { op: '−', label: 'Disputes lost', usd: totals.disputes_lost_usd, caption: 'money taken back' },
    {
      op: '=',
      label: 'Net revenue',
      usd: totals.net_revenue_usd,
      caption: 'before Stripe fees, unused credit included',
    },
  ];
  return (
    <dl className="admin-sum">
      {steps.map((step) => (
        <div key={step.label} className="admin-sum-step">
          {step.op && (
            <span className="admin-sum-op" aria-hidden="true">
              {step.op}
            </span>
          )}
          <dt>{step.label}</dt>
          <dd>
            <span className="admin-sum-value">{money(step.usd)}</span>
            <span className="admin-sub">{step.caption}</span>
          </dd>
        </div>
      ))}
    </dl>
  );
}

function Periods({ report }: { report: AdminRevenue }) {
  if (!report.periods.length)
    return <p className="source-empty">Nothing recorded in this range.</p>;
  return (
    <div className="source-table-wrap">
      <table className="source-table admin-table">
        <thead>
          <tr>
            <th>{report.by === 'month' ? 'Month' : 'Day (UTC)'}</th>
            <th className="admin-num">Gross top-ups</th>
            <th className="admin-num">Refunds</th>
            <th className="admin-num">Disputes lost</th>
            <th className="admin-num">Net revenue</th>
            <th className="admin-num">Credit consumed</th>
          </tr>
        </thead>
        <tbody>
          {report.periods.map((p) => (
            <tr key={p.period}>
              <td>{p.period}</td>
              <td className="admin-num">{money(p.gross_top_ups_usd)}</td>
              <td className="admin-num">{money(p.refunds_usd)}</td>
              <td className="admin-num">{money(p.disputes_lost_usd)}</td>
              <td className="admin-num">{money(p.net_revenue_usd)}</td>
              <td className="admin-num">{money(p.consumed_usd)}</td>
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
    <section className="admin-revenue-part">
      <h3 className="home-label">Credit outstanding</h3>
      <p className="source-meta">
        A liability, not revenue: agent use we still owe across {o.accounts} accounts, as of now.
        {o.as_of ? ` Updated ${when(o.as_of)}.` : ''}
      </p>
      <dl className="admin-figures">
        <div>
          <dt>Sold, unspent</dt>
          <dd>{money(o.sold_usd)}</dd>
        </div>
        <div>
          <dt>Frozen by open disputes</dt>
          <dd>{money(o.frozen_usd)}</dd>
        </div>
        <div>
          <dt>Refunds awaiting Stripe</dt>
          <dd>{money(o.refunds_open_usd)}</dd>
        </div>
        <div>
          <dt>Free credit, unspent</dt>
          <dd>
            {money(o.free_usd)}
            <span className="admin-sub">given away, not sold</span>
          </dd>
        </div>
      </dl>
    </section>
  );
}

function UsageRow({ label, row }: { label: string; row: AdminRevenueUsage }) {
  return (
    <tr>
      <td>{label}</td>
      <td className="admin-num">{money(row.charged_usd)}</td>
      <td className="admin-num">
        <Figure usd={row.cost_usd} />
      </td>
      <td className="admin-num">
        <Figure usd={row.margin_usd} />
      </td>
    </tr>
  );
}

function Usage({ report }: { report: AdminRevenue }) {
  const { usage, stripe_fees_usd: fees } = report;
  if (usage.consumed_usd === 0 && usage.free_granted_usd === 0)
    return (
      <section className="admin-revenue-part">
        <h3 className="home-label">Usage</h3>
        <p className="source-empty">No usage in this range.</p>
      </section>
    );
  return (
    <section className="admin-revenue-part">
      <h3 className="home-label">Usage</h3>
      <div className="source-table-wrap">
        <table className="source-table admin-table">
          <thead>
            <tr>
              <th>Charged for</th>
              <th className="admin-num">Credit consumed</th>
              <th className="admin-num">Our cost</th>
              <th className="admin-num">Margin</th>
            </tr>
          </thead>
          <tbody>
            <UsageRow label="Model calls" row={usage.model} />
            <UsageRow label="Container time" row={usage.container} />
            <UsageRow label="Calls with an unknown outcome" row={usage.unpriced} />
          </tbody>
          <tfoot>
            <tr>
              <td>All usage</td>
              <td className="admin-num">{money(usage.consumed_usd)}</td>
              <td className="admin-num">
                <Figure usd={null} />
              </td>
              <td className="admin-num">
                <Figure usd={null} />
              </td>
            </tr>
          </tfoot>
        </table>
      </div>
      <p className="source-meta">
        Model cost is the provider's usage at list rates, not an invoice
        {usage.model.markup === null ? '' : `, marked up ${usage.model.markup} times`}. Includes{' '}
        {money(usage.free_granted_usd)} of free credit granted in this range. Stripe fees:{' '}
        <Figure usd={fees} />, so nothing here is after fees.
      </p>
    </section>
  );
}

function Accounts({ report, navigate }: { report: AdminRevenue; navigate: Navigate }) {
  const { accounts } = report;
  const any = accounts.paying > 0 || accounts.active_paying > 0;
  return (
    <section className="admin-revenue-part">
      <h3 className="home-label">Accounts</h3>
      {any && (
        <dl className="admin-figures">
          <div>
            <dt>Paying</dt>
            <dd>
              {accounts.paying}
              <span className="admin-sub">topped up in this range</span>
            </dd>
          </div>
          <div>
            <dt>Active paying</dt>
            <dd>
              {accounts.active_paying}
              <span className="admin-sub">have paid, and used credit in this range</span>
            </dd>
          </div>
        </dl>
      )}
      {accounts.top.length ? (
        <div className="source-table-wrap">
          <table className="source-table admin-table">
            <thead>
              <tr>
                <th>Top paying accounts</th>
                <th className="admin-num">Gross top-ups</th>
                <th className="admin-num">Net</th>
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
                  <td className="admin-num">{money(a.gross_usd)}</td>
                  <td className="admin-num">{money(a.net_usd)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="source-empty">No paying accounts in this range.</p>
      )}
    </section>
  );
}

/** What one read of the rollup shows. */
export function RevenueReport({ report, navigate }: { report: AdminRevenue; navigate: Navigate }) {
  return (
    <>
      <Takings report={report} />
      <Periods report={report} />
      <Outstanding report={report} />
      <Usage report={report} />
      <Accounts report={report} navigate={navigate} />
      <p className="source-meta">
        Amounts are the ledger's, by UTC day. The nightly reconcile checks them against Stripe and
        logs any difference.
      </p>
    </>
  );
}
