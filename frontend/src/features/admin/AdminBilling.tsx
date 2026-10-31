// One user's Billing section (operators only, where ADMIN_BILLING is on): the balance, card,
// auto top-up and Stripe customer, what needs attention, the actions, the top-ups with their
// refunds and disputes, and the paged ledger and usage. Each action is confirmed first; the
// server checks the operator, records the audit row and holds the limits.
import { useState } from 'react';
import type { AdminBilling, AdminTopUp } from '../../../../shared/admin-billing';
import { Failure, Loading } from '../source-platform/SourceStatus';
import { useSource } from '../source-platform/useSource';
import { ActionDialog } from './AdminBillingDialogs';
import {
  DisputesTable,
  LedgerTable,
  RefundsTable,
  TopUpsTable,
  UsageTable,
} from './AdminBillingTables';
import { RefundDialog } from './AdminRefundDialog';
import { ACTION_LABEL, type BillingAction, billingPath, money } from './adminBillingModel';
import { when } from './adminModel';

const limit = (usd: number | null) => (usd === null ? 'not set' : money(usd));

/** The facts, and what an operator should know first. */
export function BillingSummary({ billing }: { billing: AdminBilling }) {
  const { balance, card, paused, refund } = billing;
  const open = billing.disputes.filter((d) => d.status === 'open').length;
  return (
    <>
      {paused && (
        <p className="admin-notice">
          Billing paused {when(paused.at)} by {paused.by ?? 'an operator'}: {paused.reason ?? ''}
        </p>
      )}
      {open > 0 && (
        <p className="admin-notice">
          {open} open dispute{open === 1 ? '' : 's'}: the credit is frozen and the card is not
          charged until {open === 1 ? 'it closes' : 'they close'}.
        </p>
      )}
      {billing.top_up_failed && (
        <p className="admin-notice">Last top-up failed: {billing.top_up_failed}</p>
      )}
      {!refund.configured && <p className="admin-notice">Refunds are not set up here.</p>}
      {refund.configured && (refund.max_usd === null || refund.daily_usd === null) && (
        <p className="admin-notice">Refund limits are not set: every refund is refused.</p>
      )}
      <dl className="admin-facts">
        <dt>Balance</dt>
        <dd>
          {money(balance.balance_usd)}
          <span className="admin-sub">
            {money(balance.granted_usd)} granted, {money(balance.used_usd)} used
          </span>
        </dd>
        <dt>Card</dt>
        <dd>{card ? `${card.brand} •••• ${card.last4}` : 'No card'}</dd>
        <dt>Auto top-up</dt>
        <dd>{billing.auto_top_up ? 'On' : 'Off'}</dd>
        <dt>Stripe</dt>
        <dd>
          {billing.stripe_url ? (
            <a href={billing.stripe_url} target="_blank" rel="noreferrer">
              {billing.customer}
            </a>
          ) : (
            'No Stripe customer'
          )}
        </dd>
        <dt>Refund limits</dt>
        <dd>
          {limit(refund.max_usd)} per refund, {limit(refund.daily_usd)} a day across all accounts (
          {money(refund.used_today_usd)} used today)
        </dd>
      </dl>
    </>
  );
}

function ActionButtons({
  billing,
  onAction,
}: {
  billing: AdminBilling;
  onAction: (action: BillingAction) => void;
}) {
  return (
    <div className="admin-actions">
      <button type="button" className="quiet" onClick={() => onAction({ kind: 'credit' })}>
        {ACTION_LABEL.credit}
      </button>
      <button
        type="button"
        className="quiet"
        disabled={!billing.auto_top_up}
        onClick={() => onAction({ kind: 'auto-top-up-off' })}
      >
        {ACTION_LABEL['auto-top-up-off']}
      </button>
      <button
        type="button"
        className="quiet"
        disabled={!billing.card}
        onClick={() => onAction({ kind: 'remove-card' })}
      >
        {ACTION_LABEL['remove-card']}
      </button>
      <button
        type="button"
        className="quiet"
        onClick={() => onAction({ kind: 'pause', paused: !billing.paused })}
      >
        {billing.paused ? 'Resume billing' : ACTION_LABEL.pause}
      </button>
    </div>
  );
}

export function AdminBillingSection({ account, name }: { account: string; name: string }) {
  const loaded = useSource<AdminBilling>(billingPath(account));
  const [refunding, setRefunding] = useState<AdminTopUp | null>(null);
  const [action, setAction] = useState<BillingAction | null>(null);
  const [done, setDone] = useState('');
  const finish = (message: string) => {
    setRefunding(null);
    setAction(null);
    setDone(message);
    loaded.reload();
  };
  const billing = loaded.data;
  return (
    <section className="home-section admin-billing" aria-labelledby="admin-user-billing">
      <h3 id="admin-user-billing" className="home-label">
        Billing
      </h3>
      {done && (
        <p role="status" className="admin-done">
          {done}
        </p>
      )}
      {loaded.loading && !billing && <Loading what="billing" />}
      {loaded.error && <Failure error={loaded.error} what="billing" onRetry={loaded.reload} />}
      {billing && (
        <>
          <BillingSummary billing={billing} />
          <ActionButtons billing={billing} onAction={setAction} />
          <h4 className="home-label">Top-ups</h4>
          <TopUpsTable billing={billing} onRefund={setRefunding} />
          <RefundsTable billing={billing} />
          <DisputesTable billing={billing} />
          <h4 className="home-label">Usage per agent run</h4>
          <UsageTable account={account} />
          <h4 className="home-label">Ledger</h4>
          <LedgerTable account={account} />
        </>
      )}
      {billing && refunding && (
        <RefundDialog
          account={account}
          name={name}
          topUp={refunding}
          billing={billing}
          onClose={() => setRefunding(null)}
          onDone={finish}
        />
      )}
      {action && (
        <ActionDialog
          account={account}
          name={name}
          action={action}
          onClose={() => setAction(null)}
          onDone={finish}
        />
      )}
    </section>
  );
}
