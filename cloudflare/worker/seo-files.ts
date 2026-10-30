// `/robots.txt` and `/sitemap.xml`. Production (SEO_INDEXING=on) invites crawlers to the site
// and public repositories and keeps them off the API, sign-in callbacks and the signed-in app;
// every other environment disallows everything. The sitemap lists the build's site pages and
// the platform's public listing (`GET /api/v1/explore`, the same answer anyone gets), capped,
// and is cached at the edge for an hour.
import { indexable, siteRoutes } from './seo-head';
import type { Env } from './types';
import { publicOrigin } from './website-metadata';

/** Public repositories a sitemap lists at most (explore pages of 100). */
const SITEMAP_REPOS = 500;
const SITEMAP_TTL_SECONDS = 3600;
// `$` ends a path: `/settings` must not also hide a handle like `/settings_fan`.
const DISALLOWED = [
  '/api/',
  '/auth/',
  '/source/',
  '/settings$',
  '/settings/',
  '/admin$',
  '/admin/',
  '/agents$',
  '/agents/',
  '/device$',
  '/device/',
  '/repositories$',
];

export function isSeoFile(pathname: string) {
  return pathname === '/robots.txt' || pathname === '/sitemap.xml';
}

export async function seoFile(req: Request, env: Env): Promise<Response> {
  const origin = publicOrigin(req, env.PUBLIC_APP_ORIGIN);
  if (!origin) return new Response('Invalid public application origin', { status: 500 });
  if (new URL(req.url).pathname === '/robots.txt') return robots(env, origin);
  return sitemap(req, env, origin);
}

function robots(env: Env, origin: string) {
  const body = indexable(env)
    ? [
        'User-agent: *',
        'Allow: /',
        ...DISALLOWED.map((path) => `Disallow: ${path}`),
        '',
        `Sitemap: ${origin}/sitemap.xml`,
        '',
      ].join('\n')
    : 'User-agent: *\nDisallow: /\n';
  return new Response(body, {
    headers: {
      'content-type': 'text/plain; charset=utf-8',
      'cache-control': 'public, max-age=3600',
    },
  });
}

async function sitemap(req: Request, env: Env, origin: string) {
  const cache = typeof caches === 'undefined' ? null : caches.default;
  const key = new Request(`${origin}/sitemap.xml`);
  const cached = await cache?.match(key).catch(() => undefined);
  if (cached) return cached;
  const site = await siteRoutes(env, origin);
  const pages = (site?.routes ?? [])
    .filter((route) => route.sitemap)
    .map((route) => ({ path: route.path, lastmod: route.published }));
  const listed = await publicRepositories(req, env);
  const repos = (listed ?? []).map((path) => ({ path, lastmod: undefined }));
  const urls = [...pages, ...repos].map(
    ({ path, lastmod }) =>
      `<url><loc>${xml(origin + path)}</loc>${lastmod ? `<lastmod>${xml(lastmod)}</lastmod>` : ''}</url>`,
  );
  const response = new Response(
    `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join('\n')}\n</urlset>\n`,
    {
      headers: {
        'content-type': 'application/xml; charset=utf-8',
        'cache-control': `public, max-age=${SITEMAP_TTL_SECONDS}`,
      },
    },
  );
  // A sitemap missing what the platform could not list right now is not kept.
  if (listed) await cache?.put(key, response.clone()).catch(() => undefined);
  return response;
}

/** Readable paths of public repositories, newest first, as the platform lists them to anyone;
 * null when the listing could not be read. */
async function publicRepositories(req: Request, env: Env): Promise<string[] | null> {
  const platform = env.PLATFORM;
  if (!platform) return [];
  const ip = req.headers.get('cf-connecting-ip');
  const paths: string[] = [];
  let before = '';
  while (paths.length < SITEMAP_REPOS) {
    const page = new URL('/api/v1/explore', req.url);
    page.searchParams.set('limit', '100');
    if (before) page.searchParams.set('before', before);
    const answer = await platform
      .fetch(new Request(page, { headers: ip ? { 'cf-connecting-ip': ip } : {} }))
      .catch(() => null);
    if (!answer?.ok) return null;
    const { repos } = await answer.json<{ repos: { path: string | null; created_at: number }[] }>();
    for (const repo of repos) if (repo.path) paths.push(repo.path);
    if (repos.length < 100) break;
    before = String(repos[repos.length - 1].created_at);
  }
  return paths.slice(0, SITEMAP_REPOS);
}

const xml = (text: string) => text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
