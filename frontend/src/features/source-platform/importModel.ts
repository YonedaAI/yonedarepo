// Adding a GitHub repository: what the dialog's field accepts, the request it makes
// (`POST /repos/import`), and what `GET /repos/<id>/import` means on the repository's page.
import type { Visibility } from './repoAccess';

export const IMPORT_HINT =
  'Use a GitHub repository address, like https://github.com/owner/repo or owner/repo.';

/** GitHub's own limits on a login and a repository name. */
const OWNER = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/;
const REPOSITORY = /^[A-Za-z0-9._-]{1,100}$/;
const HOSTS = ['github.com', 'www.github.com'];

/** The path of a github.com address, or `input` itself when it is the `owner/repo` form. A
 * host is only ever read by URL parsing: `github.com.evil.example` and `github.com@evil.example`
 * both start like GitHub. Credentials and ports never pass. */
function githubPath(input: string): string | null {
  const address = /^(www\.)?github\.com\//i.test(input) ? `https://${input}` : input;
  if (!/^[a-z][a-z0-9+.-]*:/i.test(address)) return input;
  let url: URL;
  try {
    url = new URL(address);
  } catch {
    return null;
  }
  const github =
    url.protocol === 'https:' &&
    HOSTS.includes(url.hostname) &&
    !url.port &&
    !url.username &&
    !url.password;
  return github ? url.pathname : null;
}

/** A GitHub repository from `https://github.com/owner/repo` (with or without `.git` or a
 * trailing slash) or `owner/repo`; null for anything else. `url` is its one Git remote. */
export function parseGitHubRepo(input: string) {
  const path = githubPath(input.trim());
  const parts = path?.replace(/^\//, '').replace(/\/$/, '').split('/');
  if (parts?.length !== 2) return null;
  const owner = parts[0];
  const repo = parts[1].replace(/\.git$/i, '');
  if (!OWNER.test(owner) || !REPOSITORY.test(repo) || /^\.+$/.test(repo)) return null;
  return { owner, repo, url: `https://github.com/${owner}/${repo}.git` };
}

/** The name a GitHub repository starts with here: a name here cannot start with a dot. */
export const defaultRepoName = (repo: string) => repo.replace(/^\.+/, '');

/** The import request's body, in `createBody`'s manner: `owner` only for an organization,
 * `branch` only when one was named (none: the remote's default), `visibility` always. A
 * repository picked from a connection goes by its id, and GitHub says what it is. */
export function importBody(
  url: string,
  name: string,
  owner: string,
  visibility: Visibility = 'private',
  branch = '',
  picked?: GitHubRepository,
) {
  return {
    ...(picked ? { github_repository: picked.id } : { url }),
    name,
    ...(owner ? { owner } : {}),
    visibility,
    ...(branch.trim() ? { branch: branch.trim() } : {}),
  };
}

/** Where Connect starts; the Worker takes it from there. */
export const CONNECT_PATH = '/github/connect';

const PENDING = 'github-import-source';

/** The address waiting on a trip to GitHub, kept for the way back. Storage can be unavailable:
 * the person then types it again. */
export function keepPending(source: string) {
  try {
    window.sessionStorage.setItem(PENDING, source);
  } catch {}
}

export function takePending() {
  try {
    const source = window.sessionStorage.getItem(PENDING) ?? '';
    window.sessionStorage.removeItem(PENDING);
    return source;
  } catch {
    return '';
  }
}

/** Linking GitHub is the first half of connecting: go on to the install if an import waits. */
export function continueToGitHub() {
  try {
    if (window.sessionStorage.getItem(PENDING)) window.location.assign(CONNECT_PATH);
  } catch {}
}

export type GitHubRepository = { id: number; full_name: string; private: boolean };

/** What `GET /github/repositories` answers: no `available`, no Connect on this site. */
export type GitHubConnection = {
  available: boolean;
  connection?: 'none' | 'lost' | 'ok';
  login?: string;
  repositories?: GitHubRepository[];
  more?: boolean;
};

/** The connected repository the field names, if it names one. */
export function pickedRepository(source: string, repositories: readonly GitHubRepository[] = []) {
  const parsed = parseGitHubRepo(source);
  const name = parsed && `${parsed.owner}/${parsed.repo}`.toLowerCase();
  return repositories.find((r) => r.full_name.toLowerCase() === name);
}

/** What a trip to GitHub came back with, in `?github=`, read once. */
export function connectMessage(result: string | null) {
  switch (result) {
    case null:
    case 'connected':
      return '';
    case 'org':
      return "Organizations can't connect yet. Install it on your own GitHub account.";
    case 'other_account':
      return "That isn't the GitHub account linked here. Install it on the linked one.";
    case 'unavailable':
      return "GitHub didn't answer. Try again in a moment.";
    default:
      return "Connecting didn't finish. Try again.";
  }
}

/** What `GET /repos/<id>/import` answers: the import Workflow's status. */
export type ImportAnswer = {
  status?: string;
  error?: { name?: string; message?: string } | null;
};

/** What a failed import says: a final failure's message is `<code>: <its reason>`.
 * GitHub refuses a private repository and a missing one with the same answer. */
export function importFailure(message: string | undefined) {
  // A hosted Workflow puts the error's class first: `NonRetryableError: <code>: <reason>`.
  const said = (message ?? '').replace(/^[A-Za-z]*Error: /, '');
  const [, code = '', reason = said] = /^([A-Z][A-Z0-9_]+): (.*)$/s.exec(said) ?? [];
  if (code === 'REMOTE_AUTH_REQUIRED') {
    const connect = reason.includes('Connect GitHub');
    return {
      title: connect
        ? "This repository is private, or it doesn't exist."
        : "This repository is private, or it doesn't exist. Only public GitHub repositories can be added for now.",
      reason,
      connect,
    };
  }
  if (code === 'GITHUB_RECONNECT')
    return { title: "This import can't read GitHub any more.", reason, connect: true };
  if (code === 'NOT_FOUND') return { title: "This repository or branch wasn't found.", reason };
  return { title: "Couldn't import this repository.", reason };
}

/** The import as its page shows it. Anything short of an end is still running: `waiting` is a
 * step retrying, and a status added later should not read as a failure. */
export function importView(answer: ImportAnswer) {
  if (answer.status === 'complete') return { phase: 'complete' as const };
  if (answer.status === 'terminated')
    return { phase: 'failed' as const, title: 'This import was stopped.', reason: '' };
  if (answer.status === 'errored')
    return { phase: 'failed' as const, ...importFailure(answer.error?.message) };
  return { phase: 'running' as const };
}

/** Only a repository with no refs is waiting for its code: an import lands its branch before
 * anything else shows. */
export const mayBeImport = (refs: readonly unknown[] | undefined) => refs?.length === 0;
