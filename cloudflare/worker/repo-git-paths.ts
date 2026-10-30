// Git over HTTPS by readable path: `/<handle>/<name>[.git]/info/refs` and its upload-pack and
// receive-pack, the same smart HTTP as `/git/<id>.git` (repo-git-http), which keeps working.
// The path is resolved by name (repo-paths) and the request served as by id. A path that
// names nothing, and a repository the caller may not read, answer exactly alike, so the path
// tells nobody whether a private repository exists.
import { gitCredentials, gitHttp, unknownRepository } from './repo-git-http';
import { readableBy, repoAt } from './repo-paths';

import type { Env } from './types';

/** `req` addressed by repository id. */
function byId(req: Request, repo: string, action: string) {
  const url = new URL(req.url);
  url.pathname = `/git/${repo}.git/${action}`;
  return new Request(url, req);
}

export async function gitByPath(req: Request, env: Env, path: RegExpExecArray) {
  const [, handle, name, action] = path;
  const repo = await repoAt(env, handle, name);
  if (!repo) return unknownRepository(req, env);
  const answer = await gitHttp(byId(req, repo, action), env);
  // Refused as not there, or to someone who may not read it at all: as for a path that
  // names nothing (the repository's own refusal may word it otherwise).
  if (
    answer.status === 404 ||
    (answer.status === 403 && !(await readableBy(env, await gitCredentials(req, env), repo)))
  )
    return unknownRepository(req, env);
  return answer;
}
