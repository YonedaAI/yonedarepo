// Billing controls the Agents pages and Settings → Billing share: adding a card (Stripe's own
// page, reached through the managed Worker; no card detail ever passes through YonedaRepo),
// coming back from it, removing the card after a confirmation, and switching automatic top-up.
import { useEffect, useState } from 'react';
import type {
  BillingMode,
  BillingState,
  CardOnFile,
  ManagedCredit,
} from '../../../../shared/managed-agents';
import { Dialog } from '../../components/Dialog';
import { Failure } from '../source-platform/SourceStatus';
import { managedApi } from '../source-platform/sourceApi';
import {
  autoTopUpPath,
  type CardSaveState,
  cardLabel,
  cardSavedText,
  cardSaveState,
  RETURN_PATH,
  removeCardPath,
  setupPath,
} from './billingModel';

const returnedFromStripe = () =>
  typeof window !== 'undefined' &&
  new URLSearchParams(window.location.search).get('billing') === 'added';

/** Back from Stripe (`?billing=added`): re-reads until the card shows, since the webhook that
 * records it can land a moment later, then drops the flag from the address. */
export function useCardReturn(card: CardOnFile | null, loading: boolean, reload: () => void) {
  const [returned] = useState(returnedFromStripe);
  const [tries, setTries] = useState(0);
  const saving = cardSaveState(returned, card, tries);
  useEffect(() => {
    if (saving !== 'waiting' || loading) return;
    const timer = setTimeout(() => {
      setTries((n) => n + 1);
      reload();
    }, 2000);
    return () => clearTimeout(timer);
  }, [saving, loading, reload]);
  useEffect(() => {
    if (saving !== 'saved' && saving !== 'late') return;
    const url = new URL(window.location.href);
    url.searchParams.delete('billing');
    window.history.replaceState(
      window.history.state,
      '',
      `${url.pathname}${url.search}${url.hash}`,
    );
  }, [saving]);
  return saving;
}

/** What the page says while and after the card is saved. */
export function CardSaveNotice({
  saving,
  credit,
}: {
  saving: CardSaveState;
  credit: Pick<ManagedCredit, 'promo'>;
}) {
  if (saving === 'saved')
    return (
      <p className="billing-saved" role="status">
        {cardSavedText(credit)}
      </p>
    );
  if (saving === 'waiting')
    return (
      <p className="source-meta" role="status">
        Saving your card…
      </p>
    );
  if (saving === 'late')
    return (
      <p className="source-meta" role="status">
        Stripe has not confirmed the card yet. Reload this page in a minute.
      </p>
    );
  return null;
}

/** Starts Stripe's card setup and leaves for its page; disabled where card billing is off.
 * Stripe sends the browser back to `returnTo`. */
export function AddCardButton({
  workspace,
  billing,
  label = 'Add a card',
  className,
  returnTo = RETURN_PATH,
}: {
  workspace: string;
  billing: BillingMode;
  label?: string;
  className?: string;
  returnTo?: string;
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
        body: { return_path: returnTo },
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

/** The automatic top-up switch: off, the card stays saved and is not charged. */
export function AutoTopUpSwitch({
  workspace,
  enabled,
  onChange,
}: {
  workspace: string;
  enabled: boolean;
  onChange: (next: BillingState) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function toggle(next: boolean) {
    setBusy(true);
    setError('');
    try {
      onChange(
        await managedApi<BillingState>(autoTopUpPath(workspace), {
          method: 'POST',
          body: { enabled: next },
        }),
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <label className="agent-switch">
        <input
          type="checkbox"
          role="switch"
          aria-checked={enabled}
          checked={enabled}
          disabled={busy}
          onChange={(e) => toggle(e.target.checked)}
        />
        <span>Automatic top-up</span>
      </label>
      {error && <Failure error={error} />}
    </>
  );
}
