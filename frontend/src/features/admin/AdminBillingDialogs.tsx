// The dialog for the Billing section's actions other than a refund (AdminRefundDialog.tsx): a
// reason, then a confirmation naming the customer and any amount. A goodwill credit keeps one
// request id while its dialog is open, so sending again after a lost answer is the same grant.
import { type FormEvent, useState } from 'react';
import { Dialog } from '../../components/Dialog';
import { Failure } from '../source-platform/SourceStatus';
import { sourceApi } from '../source-platform/sourceApi';
import {
  ACTION_LABEL,
  actionConfirm,
  type BillingAction,
  billingPath,
  requestId,
} from './adminBillingModel';

const REASON_MAX = 500;

export function Reason({ value, onChange }: { value: string; onChange: (reason: string) => void }) {
  return (
    <label>
      Reason (required, kept in the audit log)
      <textarea
        required
        maxLength={REASON_MAX}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
    </label>
  );
}

export function ReasonDialogBody({
  action,
  reason,
  amount,
  onReason,
  onAmount,
}: {
  action: BillingAction;
  reason: string;
  amount: string;
  onReason: (reason: string) => void;
  onAmount: (amount: string) => void;
}) {
  return (
    <>
      {action.kind === 'credit' && (
        <label>
          Credit (USD)
          <input
            type="number"
            min="0.01"
            max="1000"
            step="0.01"
            value={amount}
            onChange={(event) => onAmount(event.target.value)}
          />
        </label>
      )}
      <Reason value={reason} onChange={onReason} />
    </>
  );
}

const validCredit = (amount: string) => {
  const usd = Number(amount);
  return Number.isFinite(usd) && usd >= 0.01 && usd <= 1000;
};

export function ActionDialog({
  account,
  name,
  action,
  onClose,
  onDone,
}: {
  account: string;
  name: string;
  action: BillingAction;
  onClose: () => void;
  onDone: (message: string) => void;
}) {
  const [reason, setReason] = useState('');
  const [amount, setAmount] = useState('5');
  const [id] = useState(requestId);
  const [reviewing, setReviewing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const ready = reason.trim().length > 0 && (action.kind !== 'credit' || validCredit(amount));
  async function send() {
    setBusy(true);
    setError('');
    try {
      await sourceApi(`${billingPath(account)}/${action.kind}`, {
        method: 'POST',
        body: {
          reason: reason.trim(),
          ...(action.kind === 'credit' ? { id, usd: Number(amount) } : {}),
          ...(action.kind === 'pause' ? { paused: action.paused } : {}),
        },
      });
      onDone('Done.');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (ready) setReviewing(true);
  };
  const title =
    action.kind === 'pause' && !action.paused ? 'Resume billing' : ACTION_LABEL[action.kind];
  return (
    <Dialog title={title} onClose={onClose} locked={busy} initialFocus="textarea, input">
      {reviewing ? (
        <>
          <p>{actionConfirm(action, name, amount)}</p>
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
            <button type="button" disabled={busy} onClick={send}>
              {busy ? 'Working…' : 'Confirm'}
            </button>
          </div>
        </>
      ) : (
        <form className="admin-billing-form" onSubmit={submit}>
          <ReasonDialogBody
            action={action}
            reason={reason}
            amount={amount}
            onReason={setReason}
            onAmount={setAmount}
          />
          <div className="admin-dialog-actions">
            <button type="button" className="quiet" onClick={onClose}>
              Cancel
            </button>
            <button type="submit" disabled={!ready}>
              Review
            </button>
          </div>
        </form>
      )}
    </Dialog>
  );
}
