// The front Worker's HTTP surface (yonedarepo.com, dev.yonedarepo.com): the browser app,
// account sign-in and owner sessions, and the platform's public API proxied on the same
// origin. Repositories, Git, tokens and MCP all live on the platform Worker.
import { accountRoute } from './accounts';
import { authenticate } from './auth';
import { error, response } from './http';
import { ownerSession } from './session';
import type { Env } from './types';
import { websiteAssets } from './website-metadata';

export async function frontFetch(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  if (url.pathname === '/health')
    return response({ service: 'yonedarepo', v: 1, revision: env.BUILD_REVISION ?? 'development' });
  if (!url.pathname.startsWith('/api/')) return websiteAssets(req, env);
  if (url.pathname.startsWith('/api/v1/'))
    return env.PLATFORM
      ? env.PLATFORM.fetch(req)
      : error('NOT_FOUND', 'The source platform is not bound', 404);
  try {
    const authResponse = await accountRoute(req, env);
    if (authResponse) return authResponse;
    if (url.pathname === '/api/session' && ['POST', 'DELETE'].includes(req.method)) {
      const principal = await authenticate(req, env);
      if (!principal) return error('UNAUTHORIZED', 'Sign in to your workspace', 401);
      return principal.role === 'admin'
        ? ownerSession(req, env)
        : error('FORBIDDEN', 'Administrator connection required', 403);
    }
    return error('NOT_FOUND', 'Unknown API route', 404);
  } catch (e: any) {
    return error(e.code ?? 'REQUEST_FAILED', e.message ?? 'Request failed', 409);
  }
}
