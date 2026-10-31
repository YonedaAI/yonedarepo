// The Billing section's tables: the top-ups with their Stripe ids and what is left of each, the
// refunds, the disputes, and the paged ledger and usage per agent run.
import type {
  AdminBilling,
  AdminLedgerEntry,
  AdminRunUsage,
  AdminTopUp,
} from '../../../../shared/admin-billing';
import { PagedStatus, usePaged } from './AdminParts';
import { ledgerPath, money, usagePath } from './adminBillingModel';
import { when } from './adminModel';

/** Why a top-up can't be refunded, as the server would answer; null when it can. */
function refundBlocked(billing: AdminBilling, t: AdminTopUp) {
  if (!billing.refund.configured) return 'Refunds are not set up here';
  if (billing.refund.max_usd === null || billing.refund.daily_usd === null)
    return 'Refund limits are not set';
  if (t.disputed) return 'Disputed: no refund until it closes';
  if (t.status !== 'succeeded' || !t.payment_intent) return 'Not charged';
  if (t.refundable_usd <= 0) return 'Nothing left to refund';
  return null;
}

export function TopUpsTable({
  billing,
  onRefund,
}: {
  billing: AdminBilling;
  onRefund: (topUp: AdminTopUp) => void;
}) {
  if (!billing.top_ups.length) return <p className="source-empty">No top-ups.</p>;
  return (
    <div className="source-table-wrap">
      <table className="source-table admin-table">
        <caption className="sr-only">Top-ups</caption>
        <thead>
          <tr>
            <th>When</th>
            <th>Amount</th>
            <th>Status</th>
            <th>Stripe id</th>
            <th>Refunded</th>
            <th>Frozen</th>
            <th>Unspent</th>
            <th>
              <span className="sr-only">Refund</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {billing.top_ups.map((t) => {
            const blocked = refundBlocked(billing, t);
            return (
              <tr key={t.id}>
                <td>
                  {when(t.created_at)}
                  <span className="admin-sub">{t.id}</span>
                </td>
                <td>{money(t.amount_usd)}</td>
                <td>
                  {t.status}
                  {t.error && <span className="admin-sub">{t.error}</span>}
                </td>
                <td className="admin-mono">{t.payment_intent ?? 'none'}</td>
                <td>{money(t.refunded_usd)}</td>
                <td>{money(t.frozen_usd)}</td>
                <td>{money(t.unspent_usd)}</td>
                <td>
                  <button
                    type="button"
                    className="quiet"
                    disabled={blocked !== null}
                    title={blocked ?? undefined}
                    aria-label={`Refund ${t.id}`}
                    onClick={() => onRefund(t)}
                  >
                    Refund
                  </button>
                  {blocked && <span className="admin-sub">{blocked}</span>}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export function RefundsTable({ billing }: { billing: AdminBilling }) {
  if (!billing.refunds.length) return null;
  return (
    <div className="source-table-wrap">
      <table className="source-table admin-table">
        <caption className="sr-only">Refunds</caption>
        <thead>
          <tr>
            <th>When</th>
            <th>Amount</th>
            <th>Status</th>
            <th>Top-up</th>
            <th>By</th>
            <th>Reason</th>
          </tr>
        </thead>
        <tbody>
          {billing.refunds.map((r) => (
            <tr key={r.id}>
              <td>{when(r.created_at)}</td>
              <td>
                {money(r.amount_usd)}
                {r.spent_override && <span className="admin-sub">spent credit</span>}
              </td>
              <td>
                {r.status}
                {r.error && <span className="admin-sub">{r.error}</span>}
              </td>
              <td>{r.top_up}</td>
              <td>{r.origin === 'stripe' ? 'Stripe dashboard' : r.actor}</td>
              <td>{r.reason}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function DisputesTable({ billing }: { billing: AdminBilling }) {
  if (!billing.disputes.length) return null;
  return (
    <div className="source-table-wrap">
      <table className="source-table admin-table">
        <caption className="sr-only">Disputes</caption>
        <thead>
          <tr>
            <th>Opened</th>
            <th>Amount</th>
            <th>Frozen</th>
            <th>Status</th>
            <th>Top-up</th>
            <th>Reason</th>
          </tr>
        </thead>
        <tbody>
          {billing.disputes.map((d) => (
            <tr key={d.id}>
              <td>{when(d.opened_at)}</td>
              <td>{money(d.amount_usd)}</td>
              <td>{money(d.frozen_usd)}</td>
              <td>{d.status}</td>
              <td>{d.top_up ?? 'unknown'}</td>
              <td>{d.reason ?? ''}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function LedgerTable({ account }: { account: string }) {
  const paged = usePaged<AdminLedgerEntry>((before) => ledgerPath(account, before));
  return (
    <>
      {paged.items.length > 0 && (
        <div className="source-table-wrap">
          <table className="source-table admin-table">
            <caption className="sr-only">Ledger entries</caption>
            <thead>
              <tr>
                <th>When</th>
                <th>Kind</th>
                <th>Amount</th>
                <th>Note</th>
              </tr>
            </thead>
            <tbody>
              {paged.items.map((e) => (
                <tr key={e.id}>
                  <td>{when(e.at)}</td>
                  <td>{e.kind}</td>
                  <td>{money(e.amount_usd)}</td>
                  <td>{e.note ?? ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <PagedStatus paged={paged as never} what="the ledger" empty="No ledger entries." />
    </>
  );
}

export function UsageTable({ account }: { account: string }) {
  const paged = usePaged<AdminRunUsage>((before) => usagePath(account, before));
  return (
    <>
      {paged.items.length > 0 && (
        <div className="source-table-wrap">
          <table className="source-table admin-table">
            <caption className="sr-only">Usage per agent run</caption>
            <thead>
              <tr>
                <th>When</th>
                <th>Agent</th>
                <th>Run</th>
                <th>Calls</th>
                <th>Tokens in / out</th>
                <th>Charged</th>
              </tr>
            </thead>
            <tbody>
              {paged.items.map((u) => (
                <tr key={u.run}>
                  <td>{when(u.at)}</td>
                  <td>{u.agent ?? 'unknown'}</td>
                  <td className="admin-mono">{u.run}</td>
                  <td>{u.calls}</td>
                  <td>
                    {u.input_tokens.toLocaleString('en-US')} /{' '}
                    {u.output_tokens.toLocaleString('en-US')}
                  </td>
                  <td>{money(u.charged_usd)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <PagedStatus paged={paged as never} what="usage" empty="No agent runs." />
    </>
  );
}
