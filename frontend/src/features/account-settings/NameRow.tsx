// Settings → Profile: the name the app calls the person, shown only to them. The row opens a
// one-line form, saved with `PUT /api/auth/name`; an empty name clears it.
import { type FormEvent, useState } from 'react';
import { SettingsRow } from '../../components/SettingsSection';
import { api } from '../../lib/api';
import type { AccountIdentity } from '../../lib/types';

export function NameRow({
  identity,
  onChange,
}: {
  identity: Pick<AccountIdentity, 'display_name'>;
  onChange: (name: string | null) => void;
}) {
  const saved = identity.display_name ?? '';
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(saved);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const cancel = () => {
    setEditing(false);
    setName(saved);
    setError('');
  };
  async function save(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    if (name.trim() === saved) return cancel();
    setBusy(true);
    setError('');
    try {
      const set = await api<{ display_name: string | null }>(
        'auth/name',
        { name },
        { method: 'PUT' },
      );
      setEditing(false);
      onChange(set.display_name);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  if (!editing)
    return (
      <SettingsRow
        title="Name"
        detail={saved || 'What we call you here. Only you see it.'}
        action={
          <button type="button" className="quiet" onClick={() => setEditing(true)}>
            {saved ? 'Change' : 'Add'}
          </button>
        }
      />
    );
  return (
    <SettingsRow
      title="Name"
      detail={
        error && (
          <span role="alert" className="source-error">
            {error}
          </span>
        )
      }
      action={
        <form
          className="name-form"
          aria-label="Your name"
          onSubmit={save}
          onKeyDown={(e) => {
            if (e.key === 'Escape') cancel();
          }}
        >
          <input
            aria-label="Name"
            value={name}
            maxLength={80}
            autoComplete="name"
            // biome-ignore lint/a11y/noAutofocus: opened by pressing Change, focus belongs here
            autoFocus
            onChange={(e) => setName(e.target.value)}
          />
          <button type="submit" disabled={busy}>
            Save
          </button>
          <button type="button" className="quiet" onClick={cancel}>
            Cancel
          </button>
        </form>
      }
    />
  );
}
