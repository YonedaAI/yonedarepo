// Settings → Visibility: whether anyone may read the repository. The owning account changes
// it (admins see it, read-only); each change is confirmed in a dialog first.
import { Globe, Lock } from 'lucide-react';
import { useState } from 'react';
import { Dialog } from '../../components/Dialog';
import type { Visibility } from '../source-platform/repoAccess';
import { Failure } from '../source-platform/SourceStatus';
import { type SourceApiError, sourceApi } from '../source-platform/sourceApi';
import {
  otherVisibility,
  VISIBILITY_HELP,
  VISIBILITY_LABELS,
  visibilityConfirm,
  visibilityError,
  visibilityRequest,
} from './visibilityModel';

export function VisibilitySettings({
  repo,
  name,
  visibility,
  canChange,
  onChanged,
}: {
  repo: string;
  name: string;
  visibility: Visibility;
  /** The owning account; admins only see the current visibility. */
  canChange: boolean;
  onChanged: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const next = otherVisibility(visibility);
  const confirm = visibilityConfirm(next, name);
  const Icon = visibility === 'public' ? Globe : Lock;
  async function change() {
    setBusy(true);
    setError('');
    try {
      const request = visibilityRequest(repo, next);
      await sourceApi(request.path, { method: request.method, body: request.body });
      setConfirming(false);
      onChanged();
    } catch (e) {
      setError(visibilityError(e as SourceApiError));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section aria-labelledby="visibility-heading">
      <h2 id="visibility-heading">Visibility</h2>
      <p className="visibility-current">
        <Icon size={16} aria-hidden="true" />
        <strong>{VISIBILITY_LABELS[visibility]}</strong>
        <span className="source-meta">{VISIBILITY_HELP[visibility]}</span>
      </p>
      {canChange ? (
        <button
          type="button"
          className="quiet"
          onClick={() => {
            setError('');
            setConfirming(true);
          }}
        >
          {next === 'public' ? 'Make public…' : 'Make private…'}
        </button>
      ) : (
        <p className="source-meta">Only the repository owner can change its visibility.</p>
      )}
      {error && !confirming && <Failure error={error} />}
      {confirming && (
        <Dialog
          title={confirm.title}
          onClose={() => setConfirming(false)}
          locked={busy}
          initialFocus=".visibility-confirm-actions .quiet"
        >
          <div className="visibility-confirm">
            <p>{confirm.body}</p>
            {error && <Failure error={error} />}
            <div className="visibility-confirm-actions">
              <button
                type="button"
                className="quiet"
                disabled={busy}
                onClick={() => setConfirming(false)}
              >
                Cancel
              </button>
              <button
                type="button"
                className={next === 'public' ? 'danger' : undefined}
                disabled={busy}
                onClick={change}
              >
                {busy ? 'Saving…' : confirm.action}
              </button>
            </div>
          </div>
        </Dialog>
      )}
    </section>
  );
}
