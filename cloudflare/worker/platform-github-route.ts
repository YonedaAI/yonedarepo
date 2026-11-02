// `/api/v1/github/*`: the browser's visits to connect GitHub, and what the import dialog reads.

import { error } from './http';
import { githubPage, githubRepositories, isGitHubPage } from './platform-github-connect';
import { credentials } from './repo-api';
import { answer, failure } from './repo-api-failure';
import type { Env } from './types';

export async function githubApi(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  const signed = await credentials(req, env).catch(() => null);
  // A visit is sent back to a page whatever happens.
  if (isGitHubPage(url)) return githubPage(req, env, url, signed);
  if (!url.pathname.endsWith('/github/repositories') || req.method !== 'GET')
    return error('NOT_FOUND', 'Unknown API path', 404);
  if (!signed) return error('UNAUTHORIZED', 'Sign in to connect GitHub', 401);
  return answer(() => githubRepositories(env, signed)).catch(failure);
}
