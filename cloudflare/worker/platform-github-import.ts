// An import's source: a public address, or a repository picked from the person's connection. A
// picked one is asked of GitHub with the person's verified installation, so a request names only
// an id and GitHub says what that is: a repository outside the installation mints nothing. The
// token that proves it is dropped here; the Workflow mints its own inside each step that needs
// one (`importCredential`), so none is in its payload, state or logs.

import { NonRetryableError } from 'cloudflare:workflows';
import { githubAppOn, repositoryAccess } from './platform-github-app';
import { connection, personOf } from './platform-github-connect';
import { accessGone } from './platform-github-refused';
import { githubRemote } from './repo-git-remote';
import { ApiError, type Credentials, type Json } from './repo-ops';
import type { Env } from './types';

/** Where a private source's access is minted from. Neither id is a secret or a grant. */
export type GitHubSource = { installation: number; repository: number };

const RECONNECT = 'Connect GitHub again to add this repository';

/** What `POST /repos/import` clones. `hidden`: GitHub says the source is private. */
export async function importSource(env: Env, requester: Credentials, body: Json) {
  const repository = body.github_repository;
  if (repository === undefined) {
    const url = githubRemote(String(body.url ?? ''));
    if (!url) throw new ApiError('INVALID_INPUT', 'url must be a public GitHub repository');
    return { url, hidden: false };
  }
  if (!Number.isSafeInteger(repository) || repository <= 0)
    throw new ApiError('INVALID_INPUT', 'github_repository must be a GitHub repository id');
  if (!githubAppOn(env)) throw new ApiError('NOT_FOUND', 'GitHub is not connected here');
  const held = await connection(env, personOf(requester));
  if (held.state !== 'ok') throw new ApiError('GITHUB_NOT_CONNECTED', RECONNECT);
  const access = await repositoryAccess(env, held.installation, repository).catch((e) => {
    if (accessGone(e)) throw new ApiError('GITHUB_NOT_CONNECTED', RECONNECT);
    throw e;
  });
  const url = githubRemote(`https://github.com/${access.repository.full_name}`);
  if (!url) throw new ApiError('INVALID_INPUT', 'That repository has an unusual name');
  const github: GitHubSource = { installation: held.installation, repository };
  return { url, github, hidden: access.repository.private };
}

/** A fresh token for a private source, or nothing for a public one. */
export async function importCredential(env: Env, source: GitHubSource | undefined) {
  if (!source) return undefined;
  const access = await repositoryAccess(env, source.installation, source.repository).catch((e) => {
    if (accessGone(e)) throw new NonRetryableError(`GITHUB_RECONNECT: ${RECONNECT}`);
    throw e;
  });
  return access.token;
}

/** What a refused address adds, when there is a Connect to point to. */
export const connectHint = (env: Env, credential?: string) =>
  !credential && githubAppOn(env) ? '. Connect GitHub to add a private repository' : '';
