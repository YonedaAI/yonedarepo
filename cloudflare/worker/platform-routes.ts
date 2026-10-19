// The source platform's HTTP surface on its own: /api/v1 (REST + MCP), account sign-in for
// owner sessions, health, and the /source web UI. It routes into no agent-layer code, so a
// platform-only Worker can serve it with the agent layer switched off.
import { accountRoute } from './accounts';
import { error, response } from './http';
import { repoApi } from './repo-api';
import type { Env } from './types';

export async function platformFetch(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  if (url.pathname === '/health')
    return response({
      service: 'yonedarepo-platform',
      v: 1,
      revision: env.BUILD_REVISION ?? 'development',
    });
  if (url.pathname.startsWith('/api/v1/')) return repoApi(req, env);
  if (url.pathname.startsWith('/api/auth/') || url.pathname === '/api/session') {
    const handled = await accountRoute(req, env);
    if (handled) return handled;
  }
  if (url.pathname.startsWith('/api/'))
    return error('NOT_FOUND', 'Not part of the source platform', 404);
  if (url.pathname === '/' || url.pathname === '')
    return Response.redirect(new URL('/source', url).toString(), 302);
  return env.ASSETS.fetch(req);
}
