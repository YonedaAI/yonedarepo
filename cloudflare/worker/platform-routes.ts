// The source platform's HTTP surface: /api/v1 (REST + MCP), /git (smart HTTP for stock
// Git), /internal/ssh (the SSH gateway), account sign-in, health, and the /source web UI.
import { accountRoute } from './accounts';
import { error, response } from './http';
import { sshInternal } from './platform-ssh';
import { frontDoor } from './platform-ssh-gateway';
import { repoApi } from './repo-api';
import { gitHttp } from './repo-git-http';
import type { Env } from './types';

export async function platformFetch(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  if (url.pathname === '/health')
    return response({
      service: 'yonedarepo-platform',
      v: 1,
      revision: env.BUILD_REVISION ?? 'development',
      // How Git over SSH is reachable, or null (kit item 26 skips while it is not).
      ssh: frontDoor(env),
    });
  if (url.pathname.startsWith('/api/v1/')) return repoApi(req, env);
  // Stock Git over HTTPS: /git/<repository>.git (clone, fetch, push).
  if (url.pathname.startsWith('/git/')) return gitHttp(req, env);
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
  return env.ASSETS.fetch(req);
}
