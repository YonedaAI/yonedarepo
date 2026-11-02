// "Add GitHub repository": imports a GitHub repository as a new repository, in the manner of
// the New repository dialog. A connected account's repositories are offered in the same field,
// as it holds an address too. The import runs in the background, so what can only be known
// later (no such repository, a private one) is the new repository's page to say.
import { type FormEvent, useEffect, useId, useRef, useState } from 'react';
import { Dialog } from '../../components/Dialog';
import {
  CONNECT_PATH,
  connectMessage,
  defaultRepoName,
  type GitHubConnection,
  IMPORT_HINT,
  importBody,
  keepPending,
  parseGitHubRepo,
  pickedRepository,
  takePending,
} from '../source-platform/importModel';
import type { OrgSummary } from '../source-platform/orgModel';
import type { Visibility } from '../source-platform/repoAccess';
import { SourceApiError, sourceApi } from '../source-platform/sourceApi';
import { useSource } from '../source-platform/useSource';
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

const RESULT = 'github';

/** Whether a trip to GitHub just ended here: the dialog comes back up to say how it went. */
export const backFromGitHub = () =>
  typeof window !== 'undefined' && new URLSearchParams(window.location.search).has(RESULT);

/** That trip's outcome, read once and then dropped from the address. */
function takeConnectResult() {
  if (!backFromGitHub()) return null;
  const params = new URLSearchParams(window.location.search);
  const result = params.get(RESULT);
  params.delete(RESULT);
  const rest = params.toString();
  window.history.replaceState(null, '', `${window.location.pathname}${rest ? `?${rest}` : ''}`);
  return result;
}

export function GitHubImportDialog({
  account,
  orgs = [],
  initialOwner,
  publicAddress = false,
  onClose,
  onImported,
}: {
  account?: string;
  orgs?: OrgSummary[];
  /** Preselected owner (the open org page), when the caller owns it. */
  initialOwner?: string;
  /** A public repository by its address: nothing here needs GitHub connected. */
  publicAddress?: boolean;
  onClose: () => void;
  onImported: (created: Created) => Promise<void>;
}) {
  const hint = useId();
  const [connectResult] = useState(takeConnectResult);
  const github = useSource<GitHubConnection>('/github/repositories').data;
  const connected = github?.connection === 'ok';
  const [source, setSource] = useState(takePending);
  const [invalid, setInvalid] = useState(false);
  const [name, setName] = useState(() => {
    const parsed = parseGitHubRepo(source);
    return parsed ? defaultRepoName(parsed.repo) : '';
  });
  // The name follows the address until someone types their own.
  const [named, setNamed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const picked = pickedRepository(source, github?.repositories);
  const form = useRef<HTMLFormElement>(null);
  const typed = source.trim().toLowerCase();
  const matching = (github?.repositories ?? []).filter((r) =>
    r.full_name.toLowerCase().includes(typed),
  );
  // Choosing a repository from the list is the whole request: it starts straight away.
  const pickedId = picked?.id;
  useEffect(() => {
    if (pickedId !== undefined) form.current?.requestSubmit();
  }, [pickedId]);
  // Adding from GitHub starts on GitHub, and a public address needs none of that. Back from
  // there, the dialog stays to say what happened.
  const unconnected = !publicAddress && github?.available === true && !connected;
  useEffect(() => {
    if (unconnected && connectResult === null) window.location.assign(CONNECT_PATH);
  }, [unconnected, connectResult]);
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
        importBody(parsed.url, name.trim(), owner, visibility, branch, picked),
      );
      await onImported({ repo: created.id, owner });
    } catch (e) {
      if (e instanceof SourceApiError && e.code === 'GITHUB_NOT_CONNECTED') {
        keepPending(source);
        window.location.assign(CONNECT_PATH);
        return;
      }
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
      <form ref={form} className="new-repository" onSubmit={add}>
        <p className="source-meta import-notice">
          {github && !github.available && (
            <strong>Public GitHub repositories only for now. </strong>
          )}
          Every branch and tag is imported.{' '}
          {github?.available && !connected && (
            <a href={CONNECT_PATH}>
              {github.connection === 'lost' ? 'Connect GitHub again' : 'Connect GitHub'}
            </a>
          )}
          {github?.available && !connected && ' to add a private repository.'}
        </p>
        {connectResult && connectMessage(connectResult) && (
          <p role="alert" className="form-error">
            {connectMessage(connectResult)}
          </p>
        )}
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
            placeholder={
              connected ? 'Choose, or paste an address' : 'https://github.com/owner/repo'
            }
            inputMode="url"
            spellCheck={false}
            autoCapitalize="none"
            autoComplete="off"
            disabled={busy}
          />
        </label>
        {connected && !picked && matching.length > 0 && (
          <ul className="github-repo-list" aria-label="Your GitHub repositories">
            {matching.map((r) => (
              <li key={r.id}>
                <button type="button" disabled={busy} onClick={() => changeSource(r.full_name)}>
                  <span>{r.full_name}</span>
                  <small>{r.private ? 'Private' : 'Public'}</small>
                </button>
              </li>
            ))}
          </ul>
        )}
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
        <VisibilityField disabled={busy} onlyPrivate={picked?.private} />
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
