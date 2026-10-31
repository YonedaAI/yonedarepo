// "Add GitHub repository": imports a public GitHub repository as a new repository, in the
// manner of the New repository dialog. The import runs in the background, so what can only
// be known later (no such repository, a private one) is the new repository's page to say.
import { type FormEvent, useId, useState } from 'react';
import { Dialog } from '../../components/Dialog';
import {
  defaultRepoName,
  IMPORT_HINT,
  importBody,
  parseGitHubRepo,
} from '../source-platform/importModel';
import type { OrgSummary } from '../source-platform/orgModel';
import type { Visibility } from '../source-platform/repoAccess';
import { sourceApi } from '../source-platform/sourceApi';
import {
  CREATE_TIMEOUT_MS,
  type Created,
  createFailure,
  REPO_NAME_PATTERN,
} from './NewRepositoryDialog';
import { OwnerField, VisibilityField } from './repoFormFields';

/** Asks for the import, giving up after `timeoutMs`; the answer comes before the import ends. */
export const requestImport = (body: unknown, timeoutMs = CREATE_TIMEOUT_MS) =>
  sourceApi<{ id: string }>('/repos/import', { body, signal: AbortSignal.timeout(timeoutMs) });

export function GitHubImportDialog({
  account,
  orgs = [],
  initialOwner,
  onClose,
  onImported,
}: {
  account?: string;
  orgs?: OrgSummary[];
  /** Preselected owner (the open org page), when the caller owns it. */
  initialOwner?: string;
  onClose: () => void;
  onImported: (created: Created) => Promise<void>;
}) {
  const hint = useId();
  const [source, setSource] = useState('');
  const [invalid, setInvalid] = useState(false);
  const [name, setName] = useState('');
  // The name follows the address until someone types their own.
  const [named, setNamed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  function changeSource(next: string) {
    setSource(next);
    setInvalid(false);
    if (named) return;
    const parsed = parseGitHubRepo(next);
    setName(parsed ? defaultRepoName(parsed.repo) : '');
  }
  async function add(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const parsed = parseGitHubRepo(source);
    if (!parsed) {
      setInvalid(true);
      return;
    }
    const data = new FormData(event.currentTarget);
    const owner = String(data.get('owner') ?? '');
    const visibility: Visibility = data.get('visibility') === 'public' ? 'public' : 'private';
    const branch = String(data.get('branch') ?? '');
    setBusy(true);
    setError('');
    try {
      const created = await requestImport(
        importBody(parsed.url, name.trim(), owner, visibility, branch),
      );
      await onImported({ repo: created.id, owner });
    } catch (e) {
      setError(createFailure(e));
      setBusy(false);
    }
  }
  return (
    <Dialog
      title="Add GitHub repository"
      onClose={onClose}
      locked={busy}
      initialFocus='input[name="url"]'
    >
      <form className="new-repository" onSubmit={add}>
        <p className="source-meta import-notice">
          <strong>Public GitHub repositories only for now.</strong> The newest 5,000 commits are
          imported.
        </p>
        <OwnerField account={account} orgs={orgs} initialOwner={initialOwner} disabled={busy} />
        <label>
          GitHub repository
          <input
            name="url"
            required
            value={source}
            onChange={(event) => changeSource(event.target.value)}
            onBlur={() => setInvalid(Boolean(source.trim()) && !parseGitHubRepo(source))}
            aria-invalid={invalid || undefined}
            aria-describedby={invalid ? hint : undefined}
            placeholder="https://github.com/owner/repo"
            inputMode="url"
            spellCheck={false}
            autoCapitalize="none"
            autoComplete="off"
            disabled={busy}
          />
        </label>
        {invalid && (
          <p id={hint} role="alert" className="form-error">
            {IMPORT_HINT}
          </p>
        )}
        <label>
          Repository name
          <input
            name="name"
            required
            maxLength={100}
            pattern={REPO_NAME_PATTERN}
            title="Letters, digits, . _ and -; not starting with a dot"
            value={name}
            onChange={(event) => {
              setName(event.target.value);
              setNamed(event.target.value !== '');
            }}
            placeholder="my-service"
            autoComplete="off"
            disabled={busy}
          />
        </label>
        <VisibilityField disabled={busy} />
        <details className="source-details">
          <summary>Branch (optional)</summary>
          <label>
            Branch to import
            <input
              name="branch"
              maxLength={255}
              placeholder="The repository's default branch"
              spellCheck={false}
              autoCapitalize="none"
              autoComplete="off"
              disabled={busy}
            />
          </label>
        </details>
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
            {busy ? 'Adding…' : 'Add repository'}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
