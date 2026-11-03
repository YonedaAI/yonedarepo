// The source platform's HTTP surface: /api/v1 (REST + MCP), /git (smart HTTP for stock
// Git), /internal/ssh (the SSH gateway), account sign-in, health, and the /source web UI.
import { accountRoute } from './accounts';
import { authCounterEnv } from './auth-counter';
import { AUTH_LIMIT_PATH, authLimitResponse } from './auth-limit';
import { forwardTo, repoElsewhere } from './cell-route';
import { cellOfRegion, cellsOn, thisCell } from './cells';
import { error, response } from './http';
import { withRequestAccount } from './internal-accounts';
import { CLOSURE_PATH, closureApi } from './platform-account-close-route';
import { recordClient } from './platform-client-events';
import { githubApi } from './platform-github-route';
import { newsletterRoute } from './platform-newsletter';
import { sshInternal } from './platform-ssh';
import { frontDoor, sshWake } from './platform-ssh-gateway';
import { watchWrites } from './platform-write-origin';
import { GIT_PATH, legacyRedirect } from './readable-paths';
import { regionOfRequest } from './region';
import { regionalApiPath, regionalDispatch, withApiRegion } from './regional-api';
import { repoApi } from './repo-api';
import { gitHttp } from './repo-git-http';
import { gitByPath } from './repo-git-paths';
import type { Env } from './types';

export function platformFetch(req: Request, env: Env): Promise<Response> {
  const regional = regionalDispatch(req, env);
  if (regional) return regional;
  const url = new URL(req.url);
  // Shared sign-in allowances survive API unpinning; other API work stays local.
  if (url.pathname.startsWith('/api/auth/') || url.pathname === AUTH_LIMIT_PATH)
    env = authCounterEnv(env);
  const elsewhere = repoElsewhere(env, url);
  if (elsewhere) return forwardTo(env, elsewhere, req);
  // New-account discovery and notices remain in its chosen storage cell. API
  // execution aliases have default authority bindings even when serving Europe.
  if (
    env.API_REGION &&
    cellsOn(env) &&
    req.method === 'POST' &&
    url.pathname === '/api/auth/signup'
  ) {
    const cell = cellOfRegion(env, regionOfRequest(req));
    if (cell !== thisCell(env)) return forwardTo(env, cell, req);
  }
  return withRequestAccount(async () => {
    const started = Date.now();
    const res = await watchWrites(req, env, () => platformRoute(req, env));
    await recordClient(req, res, env, Math.random, started);
    return res;
  }).then((res) => withApiRegion(res, env));
}

async function platformRoute(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  if (url.pathname === AUTH_LIMIT_PATH) return authLimitResponse(req, env);
  if (url.pathname === '/health') {
    if (!env.API_REGION) sshWake(env);
    return response({
      service: 'yonedarepo-platform',
      v: 1,
      revision: env.BUILD_REVISION ?? 'development',
      ...(env.API_REGION && { api_region: env.API_REGION }),
      // How Git over SSH is reachable, or null (kit item 26 skips while it is not).
      ssh: frontDoor(env),
    });
  }
  if (
    env.API_REGION &&
    !regionalApiPath(url.pathname) &&
    !url.pathname.startsWith('/internal/ssh/')
  )
    return error('NOT_FOUND', 'Unknown API route', 404);
  // Public, with no credentials: the Flight log sign-up, ahead of the API's authentication.
  if (/^\/api\/v1\/newsletter(?:\/|$)/.test(url.pathname)) return newsletterRoute(req, env);
  if (url.pathname.startsWith('/api/v1/github/')) return githubApi(req, env);
  if (url.pathname === CLOSURE_PATH) return closureApi(req, env);
  if (url.pathname.startsWith('/api/v1/')) return repoApi(req, env);
  // Stock Git over HTTPS: /git/<repository>.git (clone, fetch, push), and the same by
  // readable path, /<handle>/<name>.git.
  if (url.pathname.startsWith('/git/')) return gitHttp(req, env);
  const gitPath = GIT_PATH.exec(url.pathname);
  if (gitPath) return gitByPath(req, env, gitPath);
  // The SSH gateway's key lookups and session tokens (gateway credentials only).
  if (url.pathname.startsWith('/internal/ssh/')) return sshInternal(req, env);
  if (url.pathname.startsWith('/api/auth/')) {
    const handled = await accountRoute(req, env);
    if (handled) return handled;
  }
  if (url.pathname.startsWith('/api/'))
    return error('NOT_FOUND', 'Not part of the source platform', 404);
  if (url.pathname === '/' || url.pathname === '')
    return Response.redirect(new URL('/source', url).toString(), 302);
  // The public repositories' listing lives in the web app.
  if (url.pathname === '/explore')
    return Response.redirect(new URL('/source/explore', url).toString(), 302);
  const moved = await legacyRedirect(req, (ask) => repoApi(ask, env));
  if (moved) return moved;
  return env.API_REGION ? error('NOT_FOUND', 'Unknown API route', 404) : env.ASSETS.fetch(req);
}
