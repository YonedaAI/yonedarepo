// Settings → Recovery code: a new code for a signed-in person, shown once, for an account with
// a password to reset (one made by a sign-in provider has neither).
import { useCallback, useEffect, useState } from 'react';
import { Dialog } from '../../components/Dialog';
import { SettingsRow, SettingsSection } from '../../components/SettingsSection';
import { api } from '../../lib/api';
import { Failure, Loading } from '../source-platform/SourceStatus';
import { RecoveryCodeShown } from './RecoveryCodeShown';

export function RecoveryRow({ onRegenerate }: { onRegenerate: () => void }) {
  return (
    <SettingsRow
      title="Lost or exposed your code?"
      detail="Make a new one. It resets your password if you can't use your email."
      action={
        <button
          type="button"
          className="quiet"
          aria-label="Regenerate recovery code"
          onClick={onRegenerate}
        >
          Regenerate
        </button>
      }
    />
  );
}

/** Asks first (the old code dies), then shows the new code once. */
export function RecoveryDialog({
  code,
  busy,
  error,
  onConfirm,
  onClose,
}: {
  code: string;
  busy: boolean;
  error: string;
  onConfirm: () => void;
  onClose: () => void;
}) {
  return (
    <Dialog
      title={code ? 'Save your recovery code' : 'Regenerate recovery code'}
      onClose={onClose}
      locked={busy}
    >
      {code ? (
        <>
          <RecoveryCodeShown code={code} />
          <div className="run-actions">
            <button type="button" onClick={onClose}>
              I saved it
            </button>
          </div>
        </>
      ) : (
        <>
          <p>Your old code stops working as soon as you do this.</p>
          {error && <Failure error={error} />}
          <div className="run-actions">
            <button type="button" disabled={busy} onClick={onConfirm}>
              {busy ? 'Regenerating…' : 'Regenerate'}
            </button>
          </div>
        </>
      )}
    </Dialog>
  );
}

export function RecoverySettings() {
  const [password, setPassword] = useState<boolean | null>(null);
  const [loadError, setLoadError] = useState('');
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [code, setCode] = useState('');
  const load = useCallback(() => {
    setLoadError('');
    api<{ password: boolean }>('auth/identities').then(
      (methods) => setPassword(methods.password),
      (e) => setLoadError((e as Error).message),
    );
  }, []);
  useEffect(load, [load]);
  const regenerate = async () => {
    setBusy(true);
    setError('');
    try {
      setCode((await api<{ recovery_code: string }>('auth/recovery-code', {})).recovery_code);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  if (password === false) return null;
  return (
    <SettingsSection id="recovery-code" title="Recovery code">
      {loadError ? (
        <div className="settings-block">
          <Failure error={loadError} onRetry={load} />
        </div>
      ) : password === null ? (
        <div className="settings-block">
          <Loading what="your recovery code" />
        </div>
      ) : (
        <RecoveryRow onRegenerate={() => setOpen(true)} />
      )}
      {open && (
        <RecoveryDialog
          code={code}
          busy={busy}
          error={error}
          onConfirm={regenerate}
          onClose={() => {
            setOpen(false);
            setCode('');
            setError('');
          }}
        />
      )}
    </SettingsSection>
  );
}
