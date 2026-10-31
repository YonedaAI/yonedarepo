// Adding a public GitHub repository: what the dialog's field accepts, the request it makes
// (`POST /repos/import`), and what `GET /repos/<id>/import` means on the repository's page.
import type { Visibility } from './repoAccess';

/** The server's most commits per import; the dialog always asks for all of them. */
export const MAX_IMPORT_COMMITS = 5000;

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
 * `branch` only when one was named (none: the remote's default), `visibility` always. */
export function importBody(
  url: string,
  name: string,
  owner: string,
  visibility: Visibility = 'private',
  branch = '',
) {
  return {
    url,
    name,
    ...(owner ? { owner } : {}),
    visibility,
    ...(branch.trim() ? { branch: branch.trim() } : {}),
    max_commits: MAX_IMPORT_COMMITS,
  };
}

/** What `GET /repos/<id>/import` answers: the import Workflow's status. */
export type ImportAnswer = {
  status?: string;
  error?: { name?: string; message?: string } | null;
};

/** What a failed import says: a final failure's message is `<Artifacts code>: <its reason>`.
 * GitHub refuses a private repository and a missing one with the same answer. */
export function importFailure(message: string | undefined) {
  const [, code = '', reason = message ?? ''] =
    /^([A-Z][A-Z0-9_]+): (.*)$/s.exec(message ?? '') ?? [];
  if (code === 'REMOTE_AUTH_REQUIRED')
    return {
      title:
        "This repository is private, or it doesn't exist. Only public GitHub repositories can be added for now.",
      reason,
    };
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

/** Only a repository with no refs can be mid-import: an import lands its branch last. */
export const mayBeImport = (refs: readonly unknown[] | undefined) => refs?.length === 0;
