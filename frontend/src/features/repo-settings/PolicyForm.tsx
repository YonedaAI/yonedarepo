// One policy section's form: a draft of the whole policy, saved whole with
// `PUT /repos/:id/policy`; the server's validation message is shown next to Save.
import { type FormEvent, Fragment, type ReactNode, useState } from 'react';
import { Failure } from '../source-platform/SourceStatus';
import { sourceApi } from '../source-platform/sourceApi';
import type { Policy } from './policy';

export function PolicyForm({
  repo,
  policy,
  label,
  onSaved,
  children,
}: {
  repo: string;
  policy: Policy;
  /** Names the form and its save button, e.g. "landing rules". */
  label: string;
  onSaved: () => void;
  children: (draft: Policy, change: (next: Policy) => void) => ReactNode;
}) {
  const [draft, setDraft] = useState(policy);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  // Fields that keep their own typed text start over when the draft is replaced.
  const [generation, setGeneration] = useState(0);
  // The policy read after a save (or someone else's change) replaces an unedited draft; the
  // server fills defaults, so the saved draft and the stored policy can differ in form.
  const incoming = JSON.stringify(policy);
  const [base, setBase] = useState(incoming);
  if (base !== incoming) {
    setBase(incoming);
    if (saved || JSON.stringify(draft) === base) {
      setDraft(policy);
      setGeneration((g) => g + 1);
    }
  }
  const dirty = JSON.stringify(draft) !== incoming;
  function change(next: Policy) {
    setDraft(next);
    setSaved(false);
    setError('');
  }
  async function save(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      await sourceApi(`/repos/${repo}/policy`, { method: 'PUT', body: { policy: draft } });
      setSaved(true);
      onSaved();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <form className="settings-form" aria-label={label} onSubmit={save}>
      <Fragment key={generation}>{children(draft, change)}</Fragment>
      <div className="settings-save">
        <button type="submit" disabled={busy || !dirty}>
          {busy ? 'Saving…' : `Save ${label}`}
        </button>
        {dirty && !busy && (
          <button
            type="button"
            className="quiet"
            onClick={() => {
              change(policy);
              setGeneration((g) => g + 1);
            }}
          >
            Discard changes
          </button>
        )}
        {saved && !dirty && (
          <span role="status" className="settings-saved">
            Saved. Landing uses the new policy now.
          </span>
        )}
      </div>
      {error && <Failure error={error} />}
    </form>
  );
}
