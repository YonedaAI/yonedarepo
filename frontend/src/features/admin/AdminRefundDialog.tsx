// The refund dialog has two steps: the form, which shows what the refund would do (spent credit
// needs its own confirmation, a negative balance is refused unless allowed), then a confirmation
// naming the amount and the customer. It keeps one request id while open, so sending again after
// a lost answer is the same refund; only a refund Stripe failed gets a new one.
import { type FormEvent, useState } from 'react';
import type { AdminBilling, AdminRefund, AdminTopUp } from '../../../../shared/admin-billing';
import { Dialog } from '../../components/Dialog';
import { Failure } from '../source-platform/SourceStatus';
import { sourceApi } from '../source-platform/sourceApi';
import { Reason } from './AdminBillingDialogs';
import {
  billingPath,
  defaultRefund,
  money,
  refundConfirm,
  refundPlan,
  refundResult,
  requestId,
} from './adminBillingModel';

type RefundFields = {
  amount: string;
  reason: string;
  spentOk: boolean;
  negativeOk: boolean;
};

/** The refund form: everything the refund would do, before it is confirmed. */
export function RefundForm({
  topUp,
  billing,
  onChange,
  onNext,
  onCancel,
  ...fields
}: RefundFields & {
  topUp: AdminTopUp;
  billing: AdminBilling;
  onChange: (fields: Partial<RefundFields>) => void;
  onNext: () => void;
  onCancel: () => void;
}) {
  const { amount, reason, spentOk, negativeOk } = fields;
  const plan = refundPlan(topUp, billing.balance.balance_usd, amount, billing.refund.max_usd);
  const ready =
    !plan.problem &&
    reason.trim().length > 0 &&
    (plan.spent === 0 || spentOk) &&
    (!plan.negative || negativeOk);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (ready) onNext();
  };
  return (
    <form className="admin-billing-form" onSubmit={submit}>
      <p>
        {topUp.id}: {money(topUp.amount_usd)} charged, {money(topUp.unspent_usd)} unspent,{' '}
        {money(topUp.refundable_usd)} refundable. The balance is{' '}
        {money(billing.balance.balance_usd)}.
      </p>
      <label>
        Amount (USD)
        <input
          id="admin-refund-amount"
          type="number"
          min="0.01"
          step="0.01"
          value={amount}
          aria-describedby="admin-refund-problem"
          onChange={(event) => onChange({ amount: event.target.value })}
        />
      </label>
      <p id="admin-refund-problem" className="admin-warn" role="status">
        {plan.problem ?? ''}
      </p>
      {plan.spent > 0 && (
        <label className="admin-check">
          <input
            type="checkbox"
            checked={spentOk}
            onChange={(event) => onChange({ spentOk: event.target.checked })}
          />
          <span>
            {money(plan.spent)} of this was already spent. Refund it anyway: the customer keeps what
            they used.
          </span>
        </label>
      )}
      {plan.negative && (
        <label className="admin-check">
          <input
            type="checkbox"
            checked={negativeOk}
            onChange={(event) => onChange({ negativeOk: event.target.checked })}
          />
          <span>
            The balance would go to {money(plan.after)}, and their agent runs stop until credit is
            added. Refused unless you allow it.
          </span>
        </label>
      )}
      {billing.auto_top_up && billing.card && (
        <p className="admin-sub">
          Auto top-up stays on: a low balance charges their card again. Turn it off separately.
        </p>
      )}
      <Reason value={reason} onChange={(next) => onChange({ reason: next })} />
      <div className="admin-dialog-actions">
        <button type="button" className="quiet" onClick={onCancel}>
          Cancel
        </button>
        <button type="submit" disabled={!ready}>
          Review refund
        </button>
      </div>
    </form>
  );
}

export function RefundDialog({
  account,
  name,
  topUp,
  billing,
  onClose,
  onDone,
}: {
  account: string;
  name: string;
  topUp: AdminTopUp;
  billing: AdminBilling;
  onClose: () => void;
  onDone: (message: string) => void;
}) {
  const [fields, setFields] = useState<RefundFields>({
    amount: defaultRefund(topUp),
    reason: '',
    spentOk: false,
    negativeOk: false,
  });
  const [id, setId] = useState(requestId);
  const [reviewing, setReviewing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const amount = Number(fields.amount);
  async function send() {
    setBusy(true);
    setError('');
    try {
      const { refund } = await sourceApi<{ refund: AdminRefund }>(
        `${billingPath(account)}/refund`,
        {
          method: 'POST',
          body: {
            id,
            top_up: topUp.id,
            usd: amount,
            reason: fields.reason.trim(),
            spent_override: fields.spentOk,
            allow_negative: fields.negativeOk,
          },
        },
      );
      if (refund.status === 'failed') {
        setId(requestId());
        setError(`Stripe did not refund it: ${refund.error ?? 'no reason given'}`);
        return;
      }
      onDone(refundResult(refund));
    } catch (e) {
      setError(`${(e as Error).message} Sending again can't refund twice.`);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog title="Refund" onClose={onClose} locked={busy} initialFocus="#admin-refund-amount">
      {reviewing ? (
        <>
          <p>{refundConfirm(name, topUp, amount)}</p>
          {fields.spentOk && <p className="admin-warn">This refunds spent credit.</p>}
          {fields.negativeOk && <p className="admin-warn">This leaves the balance negative.</p>}
          {error && <Failure error={error} />}
          <div className="admin-dialog-actions">
            <button
              type="button"
              className="quiet"
              disabled={busy}
              onClick={() => setReviewing(false)}
            >
              Back
            </button>
            <button type="button" className="danger" disabled={busy} onClick={send}>
              {busy ? 'Refunding…' : `Refund ${money(amount)}`}
            </button>
          </div>
        </>
      ) : (
        <RefundForm
          {...fields}
          topUp={topUp}
          billing={billing}
          onChange={(next) => setFields((f) => ({ ...f, ...next }))}
          onNext={() => setReviewing(true)}
          onCancel={onClose}
        />
      )}
    </Dialog>
  );
}
