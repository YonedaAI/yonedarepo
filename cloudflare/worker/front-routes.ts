// The front Worker's HTTP surface (yonedarepo.com, dev.yonedarepo.com): the browser app,
// the CLI installer and downloads (/install.sh, /downloads/*; see downloads.ts), robots.txt and
// sitemap.xml (seo-files.ts),
// account sign-in (password, and GitHub / Google at /auth/*), and the platform's public API
// proxied on the same origin, as is the managed agents Worker's browser API (/api/managed).
// Repositories, Git, tokens and MCP all live on the platform Worker.
import { accountRoute } from './accounts';
import { serveDownload, serveInstallScript } from './downloads';
import { error, response } from './http';
import { oauthRoute } from './oauth';
import { GIT_PATH, legacyRedirect } from './readable-paths';
import { isSeoFile, seoFile } from './seo-files';
import { recordPageView } from './site-events';
import type { Env } from './types';
import { withWebAnalytics } from './web-analytics';
import { publicOrigin, websiteAssets } from './website-metadata';

export async function frontFetch(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  if (url.pathname === '/health')
    return response({ service: 'yonedarepo', v: 1, revision: env.BUILD_REVISION ?? 'development' });
  if (url.pathname === '/install.sh')
    return serveInstallScript(req, env, publicOrigin(req, env.PUBLIC_APP_ORIGIN));
  if (url.pathname.startsWith('/downloads/')) return serveDownload(req, env);
  if (isSeoFile(url.pathname)) return seoFile(req, env);
  if (url.pathname.startsWith('/auth/')) {
    const handled = await oauthRoute(req, env);
    if (handled) return handled;
  }
  // Git over HTTPS by readable path is the platform's (`/<handle>/<name>.git`).
  if (GIT_PATH.test(url.pathname))
    return env.PLATFORM
      ? env.PLATFORM.fetch(req)
      : error('NOT_FOUND', 'The source platform is not bound', 404);
  if (!url.pathname.startsWith('/api/')) {
    const moved = env.PLATFORM
      ? await legacyRedirect(req, (ask) => (env.PLATFORM as Fetcher).fetch(ask))
      : null;
    if (moved) return moved;
    const page = await websiteAssets(req, env);
    recordPageView(req, page, env);
    return withWebAnalytics(req, page, env);
  }
  if (url.pathname.startsWith('/api/v1/'))
    return env.PLATFORM
      ? env.PLATFORM.fetch(req)
      : error('NOT_FOUND', 'The source platform is not bound', 404);
  if (url.pathname.startsWith('/api/managed/'))
    return env.MANAGED
      ? env.MANAGED.fetch(req)
      : error('NOT_FOUND', 'Managed agents are not available here', 404);
  try {
    const authResponse = await accountRoute(req, env);
    if (authResponse) return authResponse;
    return error('NOT_FOUND', 'Unknown API route', 404);
  } catch (e: any) {
    return error(e.code ?? 'REQUEST_FAILED', e.message ?? 'Request failed', 409);
  }
}
