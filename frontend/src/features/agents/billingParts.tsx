// Billing controls the Agents pages and Settings → Billing share: adding a card (Stripe's own
// page, reached through the managed Worker; no card detail ever passes through YonedaRepo),
// removing it after a confirmation, and the gate on creating your own agents.
import { useState } from 'react';
import type { BillingMode, BillingState, CardOnFile } from '../../../../shared/managed-agents';
import { Dialog } from '../../components/Dialog';
import { Failure } from '../source-platform/SourceStatus';
import { managedApi } from '../source-platform/sourceApi';
import { cardLabel, RETURN_PATH, removeCardPath, setupPath } from './billingModel';

/** Starts Stripe's card setup and leaves for its page; disabled where card billing is off. */
export function AddCardButton({
  workspace,
  billing,
  label = 'Add a card',
  className,
}: {
  workspace: string;
  billing: BillingMode;
  label?: string;
  className?: string;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  if (billing !== 'stripe')
    return (
      <button type="button" className={className} disabled title="Card billing is coming">
        {label}
      </button>
    );
  async function start() {
    setBusy(true);
    setError('');
    try {
      const { url } = await managedApi<{ url: string }>(setupPath(workspace), {
        method: 'POST',
        body: { return_path: RETURN_PATH },
      });
      window.location.assign(url);
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }
  return (
    <>
      <button type="button" className={className} disabled={busy} onClick={start}>
        {busy ? 'Opening the card form…' : label}
      </button>
      {error && <Failure error={error} />}
    </>
  );
}

/** "Remove card", confirmed first: automatic top-ups stop with it. */
export function RemoveCardButton({
  workspace,
  card,
  onRemoved,
}: {
  workspace: string;
  card: CardOnFile;
  onRemoved: (next: BillingState) => void;
}) {
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function remove() {
    setBusy(true);
    setError('');
    try {
      onRemoved(
        await managedApi<BillingState>(removeCardPath(workspace), { method: 'POST', body: {} }),
      );
      setAsking(false);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <button type="button" className="quiet" onClick={() => setAsking(true)}>
        Remove card
      </button>
      {asking && (
        <Dialog title="Remove this card?" onClose={() => setAsking(false)} locked={busy}>
          <p>
            {cardLabel(card)} will no longer top up your agent credit. Runs continue on the credit
            you have and stop when it runs out.
          </p>
          {error && <Failure error={error} />}
          <div className="agent-dialog-actions">
            <button type="button" className="danger" disabled={busy} onClick={remove}>
              {busy ? 'Removing…' : 'Remove card'}
            </button>
            <button
              type="button"
              className="quiet"
              disabled={busy}
              onClick={() => setAsking(false)}
            >
              Keep it
            </button>
          </div>
        </Dialog>
      )}
    </>
  );
}
