// Each page's head for crawlers and link previews, decided before any script runs. Site pages
// come from the build's route manifest (`/_site/routes.json`, frontend/src/features/site/seo.ts)
// and are served from their prerendered copies (`/_site/<path>`, frontend/vite-prerender.ts).
// A repository page is named only when the platform answers it to anyone (public); private and
// unknown ones get noindex and the default head, so their names never enter the page.
import { normalizeHandle } from '../../shared/account';
import type { Env } from './types';

type SeoRoute = {
  path: string;
  name: string;
  title: string;
  description: string;
  kind: 'home' | 'post' | 'docs' | 'page';
  sitemap: boolean;
  published?: string;
  author?: string;
  image?: string;
  breadcrumbs?: { name: string; path: string }[];
};
type Manifest = { routes: SeoRoute[]; aliases: Record<string, string> };
type Site = { byPath: Map<string, SeoRoute>; aliases: Record<string, string>; routes: SeoRoute[] };

export type PageHead = {
  title?: string;
  description?: string;
  /** The page's own clean path; absent where the page has none to claim. */
  canonical?: string;
  /** The asset to serve instead of the request's own path (a prerendered copy). */
  asset?: string;
  noindex?: boolean;
  route?: SeoRoute;
};

/** The signed-in app's first path segments: never worth indexing. */
const APP_ROOTS = new Set([
  'admin',
  'agents',
  'auth',
  'device',
  'repositories',
  'settings',
  'source',
]);
/** A repository's name (repo_store `repo_init`, frontend repoNames.ts REPO_NAME). */
const REPO_NAME = /^(?!\.)[A-Za-z0-9._-]{1,100}$/;
const SITE_NAME = 'YonedaRepo';
const ORGANIZATION = 'Yoneda Labs';

/** Whether this environment may be indexed (production's `SEO_INDEXING=on`). */
export const indexable = (env: Env) => env.SEO_INDEXING === 'on';

// One parsed manifest per assets binding (an isolate serves one deployment's assets); a miss is
// asked again next time, so a failed read does not last the isolate's life.
const manifests = new WeakMap<object, Promise<Site | null>>();

/** The build's site routes, or null where the build wrote none (a dev server, an old build). */
export function siteRoutes(env: Env, origin: string): Promise<Site | null> {
  let site = manifests.get(env.ASSETS);
  if (!site) {
    site = env.ASSETS.fetch(new Request(`${origin}/_site/routes.json`))
      .then(async (r) => {
        if (!r.ok || !r.headers.get('content-type')?.includes('json')) return null;
        const manifest = await r.json<Manifest>();
        return {
          routes: manifest.routes,
          aliases: manifest.aliases,
          byPath: new Map(manifest.routes.map((route) => [route.path, route])),
        };
      })
      .catch(() => null)
      .then((found) => {
        if (!found) manifests.delete(env.ASSETS);
        return found;
      });
    manifests.set(env.ASSETS, site);
  }
  return site;
}

/** A site page's head and prerendered copy, or undefined for any other path. */
export async function siteHead(req: Request, env: Env): Promise<PageHead | undefined> {
  const url = new URL(req.url);
  const path = `/${url.pathname.split('/').filter(Boolean).join('/')}`;
  const site = await siteRoutes(env, url.origin);
  const route = site?.byPath.get(site.aliases[path] ?? path);
  if (!route) return undefined;
  return {
    route,
    title: route.title,
    description: route.description,
    canonical: route.path,
    asset: route.sitemap ? `/_site${route.path === '/' ? '/home' : route.path}` : undefined,
  };
}

/** The head of an HTML page that is not a site page: the app's, a profile's or a repository's. */
export async function appHead(req: Request, env: Env): Promise<PageHead> {
  const parts = new URL(req.url).pathname.split('/').filter(Boolean);
  if (!parts.length) return { canonical: '/' };
  if (APP_ROOTS.has(parts[0])) return { noindex: true };
  if (parts.length === 2 && normalizeHandle(parts[0]) && REPO_NAME.test(parts[1]))
    return repositoryHead(req, env, parts[0], parts[1]);
  return {};
}

/** A public repository's head; noindex for one nobody signed out may read. */
async function repositoryHead(req: Request, env: Env, handle: string, name: string) {
  if (!env.PLATFORM) return { noindex: true };
  // Asked as nobody (no cookie): a private repository answers as one that is not there. The
  // visitor's address keeps the platform's per-address limit on anonymous reads theirs.
  const ip = req.headers.get('cf-connecting-ip');
  const asked = new Request(
    `${new URL(req.url).origin}/api/v1/resolve/${encodeURIComponent(handle)}/${encodeURIComponent(name)}`,
    { headers: ip ? { 'cf-connecting-ip': ip } : {} },
  );
  const answer = await env.PLATFORM.fetch(asked).catch(() => null);
  if (answer?.status === 404) return { noindex: true };
  if (!answer?.ok) return {};
  const repo = await answer.json<{ handle: string; name: string; path: string }>();
  const title = `${repo.handle}/${repo.name}`;
  return {
    title: `${title} · ${SITE_NAME}`,
    description: `${title}, a public repository on ${SITE_NAME}.`,
    canonical: repo.path,
  };
}

/** The page's structured data (schema.org JSON-LD), from the manifest's facts only. */
export function structuredData(route: SeoRoute | undefined, origin: string): object[] {
  if (!route) return [];
  const url = (path: string) => `${origin}${path}`;
  const organization = {
    '@type': 'Organization',
    name: ORGANIZATION,
    url: url('/'),
    logo: url('/brand/mark.svg'),
  };
  const context = 'https://schema.org';
  if (route.kind === 'home')
    return [
      { '@context': context, ...organization },
      {
        '@context': context,
        '@type': 'SoftwareApplication',
        name: SITE_NAME,
        url: url('/'),
        applicationCategory: 'DeveloperApplication',
        description: route.description,
        publisher: { '@type': 'Organization', name: ORGANIZATION },
      },
    ];
  if (route.kind === 'post')
    return [
      {
        '@context': context,
        '@type': 'BlogPosting',
        headline: route.name,
        description: route.description,
        ...(route.published ? { datePublished: route.published } : {}),
        author:
          !route.author || route.author === ORGANIZATION
            ? { '@type': 'Organization', name: ORGANIZATION }
            : { '@type': 'Person', name: route.author },
        ...(route.image ? { image: url(route.image) } : {}),
        url: url(route.path),
        mainEntityOfPage: url(route.path),
        publisher: organization,
      },
    ];
  if (route.kind === 'docs' && route.breadcrumbs && route.breadcrumbs.length > 1)
    return [
      {
        '@context': context,
        '@type': 'BreadcrumbList',
        itemListElement: route.breadcrumbs.map((crumb, at) => ({
          '@type': 'ListItem',
          position: at + 1,
          name: crumb.name,
          item: url(crumb.path),
        })),
      },
    ];
  return [];
}
