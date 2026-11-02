// "Add GitHub repository": imports a GitHub repository as a new repository, in the manner of
// the New repository dialog. A connected account's repositories are offered in the same field,
// as it holds an address too. "Add public repository" is the address alone. The import runs in the background, so what can only be known
// later (no such repository, a private one) is the new repository's page to say.
import { type FormEvent, useEffect, useId, useRef, useState } from 'react';
import { Dialog } from '../../components/Dialog';
import {
  ADD_CONNECTION_PATH,
  addedRepo,
  badAddress,
  CONNECT_PATH,
  connectMessage,
  defaultRepoName,
  type GitHubConnection,
  IMPORT_HINT,
  importBody,
  installationLabel,
  keepPending,
  parseGitHubRepo,
  pickedRepository,
  showsDetails,
  takePending,
} from '../source-platform/importModel';
import type { OrgSummary } from '../source-platform/orgModel';
import type { Visibility } from '../source-platform/repoAccess';
import { SourceApiError, sourceApi } from '../source-platform/sourceApi';
import { useSource } from '../source-platform/useSource';
import { useBackToTab } from './backToTab';
import { GitHubRepoList } from './GitHubRepoList';
import { ImportDetails } from './ImportDetails';
import { CREATE_TIMEOUT_MS, type Created, createFailure } from './NewRepositoryDialog';
import { OwnerField } from './repoFormFields';
import type { PlatformRepo } from './repoRows';

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
  repos = [],
  initialOwner,
  publicAddress = false,
  onClose,
  onImported,
  onOpen,
}: {
  account?: string;
  orgs?: OrgSummary[];
  /** The account's repositories: one already added opens instead of failing to import. */
  repos?: PlatformRepo[];
  /** Preselected owner (the open org page), when the caller owns it. */
  initialOwner?: string;
  /** A public repository by its address: nothing here needs GitHub connected. */
  publicAddress?: boolean;
  onClose: () => void;
  onImported: (created: Created) => Promise<void>;
  onOpen?: (repo: string) => void;
}) {
  const hint = useId();
  const [connectResult] = useState(takeConnectResult);
  const [from, setFrom] = useState<number>();
  // A public address needs nothing from GitHub, so the dialog asks it nothing.
  const listing = useSource<GitHubConnection>(
    publicAddress ? null : `/github/repositories${from ? `?installation=${from}` : ''}`,
  );
  // A failed refetch keeps the list: it says nothing about the connection.
  const lastListing = useRef<GitHubConnection | undefined>(undefined);
  if (listing.data) lastListing.current = listing.data;
  const github = listing.data ?? lastListing.current;
  const connected = github?.connection === 'ok';
  const installations = github?.installations ?? [];
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
  const [owner, setOwner] = useState(() =>
    orgs.some((o) => o.org === initialOwner && o.role === 'owner') ? initialOwner : undefined,
  );
  const ownerName = owner || account;
  const taken = name.trim() ? addedRepo(repos, ownerName, name.trim()) : undefined;
  const addedOf = (fullName: string) => {
    const parsed = parseGitHubRepo(fullName);
    return parsed ? addedRepo(repos, ownerName, defaultRepoName(parsed.repo))?.id : undefined;
  };
  const form = useRef<HTMLFormElement>(null);
  const typed = source.trim().toLowerCase();
  const matching = (github?.repositories ?? []).filter((r) =>
    r.full_name.toLowerCase().includes(typed),
  );
  // What the field held on coming back from GitHub. A repository added there can complete what
  // was typed: that is no choice made here, so it waits for Add repository.
  const typedBefore = useRef<string | null>(null);
  const starting = Boolean(picked) && !taken && !error && typedBefore.current !== source;
  const details = showsDetails({
    publicAddress,
    github,
    address: parseGitHubRepo(source) !== null,
    starting,
  });
  const openedGitHub = useBackToTab(() => {
    typedBefore.current = source;
    listing.reload();
  });
  // Choosing a repository from the list is the whole request: it starts straight away.
  const pickedId = picked?.id;
  // biome-ignore lint/correctness/useExhaustiveDependencies: once per repository picked
  useEffect(() => {
    if (pickedId !== undefined && typedBefore.current !== source && !taken)
      form.current?.requestSubmit();
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
        importBody(
          parsed.url,
          name.trim(),
          owner,
          visibility,
          branch,
          picked,
          github?.installation,
        ),
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
      title={publicAddress ? 'Add public repository' : 'Add GitHub repository'}
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
          {connected && <a href={ADD_CONNECTION_PATH}>Add an organization</a>}
        </p>
        {connectResult && connectMessage(connectResult) && (
          // GitHub waiting on an owner is news, not a failure.
          <p
            role={connectResult === 'requested' ? 'status' : 'alert'}
            className={connectResult === 'requested' ? 'source-note' : 'form-error'}
          >
            {connectMessage(connectResult)}
          </p>
        )}
        <OwnerField
          account={account}
          orgs={orgs}
          initialOwner={initialOwner}
          disabled={busy}
          onOwner={setOwner}
        />
        {installations.length > 1 && (
          <label>
            GitHub account
            <select
              value={github?.installation}
              onChange={(event) => {
                lastListing.current = undefined;
                setFrom(Number(event.target.value));
              }}
              disabled={busy}
            >
              {installations.map((i) => (
                <option key={i.id} value={i.id}>
                  {installationLabel(i)}
                </option>
              ))}
            </select>
          </label>
        )}
        <label>
          GitHub repository
          <input
            name="url"
            required
            value={source}
            onChange={(event) => changeSource(event.target.value)}
            onBlur={() => setInvalid(badAddress(source, connected))}
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
        {connected && !picked && (
          <GitHubRepoList
            repositories={github?.repositories ?? []}
            matching={matching}
            manageUrl={github?.manage_url}
            addedOf={addedOf}
            busy={busy}
            onPick={changeSource}
            onOpen={(repo) => onOpen?.(repo)}
            onOpenGitHub={openedGitHub}
          />
        )}
        {invalid && (
          <p id={hint} role="alert" className="form-error">
            {IMPORT_HINT}
          </p>
        )}
        {starting && !details && <p role="status">Adding {picked?.full_name}…</p>}
        {details && (
          <ImportDetails
            name={name}
            onName={(next) => {
              setName(next);
              setNamed(next !== '');
            }}
            onlyPrivate={picked?.private}
            taken={taken}
            error={error}
            busy={busy}
            onOpen={onOpen}
            onClose={onClose}
          />
        )}
      </form>
    </Dialog>
  );
}
