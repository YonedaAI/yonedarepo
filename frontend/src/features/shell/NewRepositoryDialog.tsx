// "New repository": a platform repository seeded with a README, owned by the account or by
// one of the organizations it owns, private (the default) or public.
import { type FormEvent, useState } from 'react';
import { Dialog } from '../../components/Dialog';
import { VISIBILITIES, VISIBILITY_HELP, VISIBILITY_LABELS } from '../repo-settings/visibilityModel';
import { type OrgSummary, ownerOptions } from '../source-platform/orgModel';
import type { Visibility } from '../source-platform/repoAccess';
import { sourceApi } from '../source-platform/sourceApi';

export const REPO_NAME_PATTERN = '[A-Za-z0-9_\\-][A-Za-z0-9._\\-]{0,99}';

/** The first commit's README: the name as its title, then the description. */
export function readmeSeed(name: string, description: string) {
  const text = description.trim() ? `# ${name}\n\n${description.trim()}\n` : `# ${name}\n`;
  let binary = '';
  for (const byte of new TextEncoder().encode(text)) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/** The new repository, and its owner (`''`: the caller's own account). */
export type Created = { repo: string; owner: string };

/** The create request's body: `owner` only for an organization (the caller is the default);
 * `visibility` always, so the choice never depends on the server's default. */
export function createBody(
  name: string,
  description: string,
  owner: string,
  visibility: Visibility = 'private',
) {
  return {
    name,
    ...(owner ? { owner } : {}),
    visibility,
    policy: { required_checks: [], approvals: 1 },
    files: [{ path: 'README.md', content_b64: readmeSeed(name, description) }],
    author: { name: 'Repository owner', email: 'owner@yonedarepo.invalid' },
  };
}

export function NewRepositoryDialog({
  account,
  orgs = [],
  initialOwner,
  onClose,
  onCreated,
}: {
  account?: string;
  orgs?: OrgSummary[];
  /** Preselected owner (the open org page), when the caller owns it. */
  initialOwner?: string;
  onClose: () => void;
  onCreated: (created: Created) => Promise<void>;
}) {
  const owners = ownerOptions(account, orgs);
  const preselected = owners.some((o) => o.value && o.value === initialOwner) ? initialOwner : '';
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const data = new FormData(event.currentTarget);
    const name = String(data.get('name') ?? '').trim();
    const description = String(data.get('description') ?? '');
    const owner = String(data.get('owner') ?? '');
    const visibility: Visibility = data.get('visibility') === 'public' ? 'public' : 'private';
    setBusy(true);
    setError('');
    try {
      const created = await sourceApi<{ id: string }>('/repos', {
        body: createBody(name, description, owner, visibility),
      });
      await onCreated({ repo: created.id, owner });
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }
  return (
    <Dialog
      title="New repository"
      onClose={onClose}
      locked={busy}
      initialFocus='input[name="name"]'
    >
      <form className="new-repository" onSubmit={create}>
        {owners.length > 1 && (
          <label>
            Owner
            <select name="owner" defaultValue={preselected} disabled={busy}>
              {owners.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </label>
        )}
        <label>
          Repository name
          <input
            name="name"
            required
            maxLength={100}
            pattern={REPO_NAME_PATTERN}
            title="Letters, digits, . _ and -; not starting with a dot"
            placeholder="my-service"
            autoComplete="off"
            disabled={busy}
          />
        </label>
        <label>
          Description (optional)
          <textarea name="description" maxLength={500} rows={2} disabled={busy} />
        </label>
        <fieldset className="visibility-choice" disabled={busy}>
          <legend>Visibility</legend>
          {/* Each radio is named by its label alone ("Private", "Public"); the help text is
              its description, outside the label, so no other control's name says "Owner". */}
          {VISIBILITIES.map((v) => (
            <div key={v} className="visibility-option">
              <label>
                <input
                  type="radio"
                  name="visibility"
                  value={v}
                  defaultChecked={v === 'private'}
                  aria-describedby={`visibility-${v}-help`}
                />
                <strong>{VISIBILITY_LABELS[v]}</strong>
              </label>
              <small id={`visibility-${v}-help`}>{VISIBILITY_HELP[v]}</small>
            </div>
          ))}
        </fieldset>
        {error && (
          <p role="alert" className="form-error">
            {error}
          </p>
        )}
        <div className="new-repository-actions">
          <button type="button" className="quiet" disabled={busy} onClick={onClose}>
            Cancel
          </button>
          <button type="submit" disabled={busy}>
            {busy ? 'Creating…' : 'Create repository'}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
