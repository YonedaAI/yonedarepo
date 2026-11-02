// The front Worker's HTTP surface (yonedarepo.com, dev.yonedarepo.com): the browser app,
// the CLI installers and downloads (/install.sh, /install.ps1, /downloads/*; see downloads.ts),
// robots.txt and sitemap.xml (seo-files.ts),
// account sign-in (password, and GitHub / Google at /auth/*), and the platform's public API
// proxied on the same origin, as is the managed agents Worker's browser API (/api/managed).
// Repositories, Git, tokens and MCP all live on the platform Worker.

import { accountRoute } from './accounts';
import { frontEnv, signInEnv } from './cell-edge';
import { cellsOn } from './cells';
import { clientError } from './client-errors';
import { isInstaller, serveDownload, serveInstallScript } from './downloads';
import { error, response } from './http';
import { logFailure } from './log';
import { oauthRoute } from './oauth';
import { GIT_PATH, legacyRedirect } from './readable-paths';
import { carriedRequest } from './request-scope';
import { isSeoFile, seoFile } from './seo-files';
import { recordPageView } from './site-events';
import { sitePing } from './site-ping';
import type { Env } from './types';
import { withWebAnalytics } from './web-analytics';
import { publicOrigin, websitePage } from './website-metadata';

const GITHUB_PAGES = new Set(['/github/connect', '/github/connected']);

export async function frontFetch(req: Request, bound: Env): Promise<Response> {
  const env = frontEnv(bound);
  const url = new URL(req.url);
  if (url.pathname === '/health')
    return response({ service: 'yonedarepo', v: 1, revision: env.BUILD_REVISION ?? 'development' });
  if (isInstaller(url.pathname))
    return serveInstallScript(req, env, publicOrigin(req, env.PUBLIC_APP_ORIGIN));
  if (url.pathname.startsWith('/downloads/')) return serveDownload(req, env);
  if (isSeoFile(url.pathname)) return seoFile(req, env);
  if (url.pathname.startsWith('/auth/')) {
    const handled = await oauthRoute(req, signInEnv(req, env));
    if (handled) return handled;
  }
  // Connecting GitHub is the platform's, on its own paths: the App's setup URL is one of them.
  if (GITHUB_PAGES.has(url.pathname) && env.PLATFORM)
    return env.PLATFORM.fetch(
      carriedRequest(new Request(`${url.origin}/api/v1${url.pathname}${url.search}`, req)),
    );
  // Git over HTTPS by readable path is the platform's (`/<handle>/<name>.git`).
  if (GIT_PATH.test(url.pathname))
    return env.PLATFORM
      ? env.PLATFORM.fetch(carriedRequest(req))
      : error('NOT_FOUND', 'The source platform is not bound', 404);
  if (!url.pathname.startsWith('/api/')) {
    const moved = env.PLATFORM
      ? await legacyRedirect(req, (ask) => (env.PLATFORM as Fetcher).fetch(ask))
      : null;
    if (moved) return moved;
    const { response: page, canonical } = await websitePage(req, env);
    recordPageView(req, page, canonical, env);
    return withWebAnalytics(req, page, env);
  }
  if (url.pathname === '/api/e') return sitePing(req, env);
  if (url.pathname === '/api/client-error') return clientError(req, env);
  if (url.pathname.startsWith('/api/v1/'))
    return env.PLATFORM
      ? env.PLATFORM.fetch(carriedRequest(req))
      : error('NOT_FOUND', 'The source platform is not bound', 404);
  if (url.pathname.startsWith('/api/managed/'))
    return env.MANAGED
      ? env.MANAGED.fetch(carriedRequest(req))
      : error('NOT_FOUND', 'Managed agents are not available here', 404);
  // Sign-in stays on a pinned Worker: its limiter is one count per cell, not one per location.
  if (cellsOn(env) && env.PLATFORM && url.pathname.startsWith('/api/auth/'))
    return env.PLATFORM.fetch(carriedRequest(req));
  try {
    const authResponse = await accountRoute(req, env);
    if (authResponse) return authResponse;
    return error('NOT_FOUND', 'Unknown API route', 404);
  } catch (e: any) {
    if (!e.code) logFailure(e, 'REQUEST_FAILED', 409);
    return error(e.code ?? 'REQUEST_FAILED', e.message ?? 'Request failed', 409);
  }
}
