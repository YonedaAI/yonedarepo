// Asked once after sign-in of an account named by its email address: pick the handle its
// profile and repositories are addressed by. Prefilled with the suggestion the session offers
// (from a linked GitHub login), checked as it is typed (`/profiles/<handle>`: nobody there
// means free), and set with `PUT /api/auth/handle`, which has the last word (reserved, taken).
import { type FormEvent, useEffect, useId, useState } from 'react';
import { Dialog } from '../../components/Dialog';
import { ApiError, api } from '../../lib/api';
import type { AccountIdentity } from '../../lib/types';
import { sourceApi } from '../source-platform/sourceApi';
import {
  type Availability,
  HANDLE_HELP,
  handleProblem,
  handleRefusal,
  needsHandle,
} from './handleModel';

/** The picker when `identity` needs a handle; "Not now" holds until the next page load. */
export function HandlePrompt({
  identity,
  onSet,
}: {
  /** Null while the prompt must wait (signed out, or another dialog is open). */
  identity: AccountIdentity | null;
  onSet: (handle: string) => void;
}) {
  const [later, setLater] = useState(false);
  if (later || !needsHandle(identity)) return null;
  return (
    <HandlePicker
      suggestion={identity?.handle_suggestion}
      onLater={() => setLater(true)}
      onDone={onSet}
    />
  );
}

export function HandlePicker({
  suggestion,
  onDone,
  onLater,
}: {
  suggestion?: string | null;
  /** The handle is set: the caller reads the session again. */
  onDone: (handle: string) => void;
  onLater: () => void;
}) {
  const [value, setValue] = useState(suggestion ?? '');
  const [availability, setAvailability] = useState<Availability>('unknown');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const help = useId();
  const problem = handleProblem(value);
  useEffect(() => {
    if (!value || problem) {
      setAvailability('unknown');
      return;
    }
    setAvailability('checking');
    let current = true;
    const timer = setTimeout(() => {
      sourceApi(`/profiles/${value}`).then(
        () => current && setAvailability('taken'),
        (e) => current && setAvailability(e?.code === 'NOT_FOUND' ? 'available' : 'unknown'),
      );
    }, 350);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [value, problem]);
  async function save(event: FormEvent) {
    event.preventDefault();
    if (busy || problem || !value) return;
    setBusy(true);
    setError('');
    try {
      const set = await api<{ handle: string }>(
        'auth/handle',
        { handle: value },
        { method: 'PUT' },
      );
      onDone(set.handle ?? value);
    } catch (e) {
      const code = e instanceof ApiError ? e.code : '';
      setError(handleRefusal(code, value, (e as Error).message));
      if (code === 'HANDLE_TAKEN') setAvailability('taken');
      setBusy(false);
    }
  }
  const status =
    problem ||
    (availability === 'checking'
      ? 'Checking…'
      : availability === 'available'
        ? `${value} is available.`
        : availability === 'taken'
          ? `${value} is taken.`
          : HANDLE_HELP);
  return (
    <Dialog title="Choose your handle" onClose={onLater} locked={busy} initialFocus="input">
      <form className="handle-picker" onSubmit={save}>
        <p className="source-meta">
          Your profile and repositories get readable addresses, like{' '}
          <code>/{value || 'handle'}/my-repo</code>. Your email address is never shown.
        </p>
        <label>
          Handle
          <span className="handle-input">
            <span aria-hidden="true">/</span>
            <input
              name="handle"
              value={value}
              onChange={(e) => {
                setValue(e.target.value.trim());
                setError('');
              }}
              required
              maxLength={32}
              autoComplete="username"
              autoCapitalize="none"
              spellCheck={false}
              aria-describedby={help}
              aria-invalid={Boolean(problem || availability === 'taken') || undefined}
              disabled={busy}
            />
          </span>
        </label>
        <p
          id={help}
          className={`field-help handle-status handle-${problem ? 'problem' : availability}`}
          aria-live="polite"
        >
          {status}
        </p>
        {error && (
          <p role="alert" className="form-error">
            {error}
          </p>
        )}
        <div className="handle-actions">
          <button type="button" className="quiet" onClick={onLater} disabled={busy}>
            Not now
          </button>
          <button
            type="submit"
            disabled={busy || !value || Boolean(problem) || availability === 'taken'}
          >
            {busy ? 'Saving…' : 'Use this handle'}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
