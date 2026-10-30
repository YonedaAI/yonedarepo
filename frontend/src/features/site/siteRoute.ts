// The public site's addresses (`/features`, `/pricing`, `/docs/...`, `/blog/...`,
// `/company/...`, `/signin`, `/signup`, `/terms`, `/privacy`) and when `/` shows the public home instead of the app.
import type { SourceRoute } from '../source-platform/sourceRoute';

export type SitePage =
  | { page: 'home' }
  | { page: 'features' }
  | { page: 'pricing' }
  | { page: 'docs'; slug: string }
  | { page: 'blog' }
  | { page: 'post'; slug: string }
  | { page: 'about' }
  | { page: 'vision' }
  | { page: 'legal'; doc: 'terms' | 'privacy' }
  | { page: 'signin'; mode: 'login' | 'signup' };

export const DOCS_HOME = 'introduction';
const SLUG = /^[a-z0-9][a-z0-9-]*$/;

/** A site page for a path's segments, or undefined for the app's own paths. */
export function parseSitePath(parts: string[]): SitePage | undefined {
  const [root, ...rest] = parts;
  if (root === 'features' && !rest.length) return { page: 'features' };
  if (root === 'pricing' && !rest.length) return { page: 'pricing' };
  if (root === 'signin' && !rest.length) return { page: 'signin', mode: 'login' };
  if (root === 'signup' && !rest.length) return { page: 'signin', mode: 'signup' };
  if (root === 'docs' && rest.every((part) => SLUG.test(part)))
    return { page: 'docs', slug: rest.length ? rest.join('/') : DOCS_HOME };
  if (root === 'blog' && !rest.length) return { page: 'blog' };
  if (root === 'blog' && rest.length === 1 && SLUG.test(rest[0]))
    return { page: 'post', slug: rest[0] };
  if (root === 'company' && (!rest.length || (rest.length === 1 && rest[0] === 'about')))
    return { page: 'about' };
  if (root === 'company' && rest.length === 1 && rest[0] === 'vision') return { page: 'vision' };
  if ((root === 'terms' || root === 'privacy') && !rest.length) return { page: 'legal', doc: root };
  return undefined;
}

export function formatSitePage(site: SitePage): string {
  switch (site.page) {
    case 'home':
      return '/';
    case 'docs':
      return site.slug === DOCS_HOME ? '/docs' : `/docs/${site.slug}`;
    case 'post':
      return `/blog/${site.slug}`;
    case 'about':
    case 'vision':
      return `/company/${site.page}`;
    case 'signin':
      return site.mode === 'login' ? '/signin' : '/signup';
    case 'legal':
      return `/${site.doc}`;
    default:
      return `/${site.page}`;
  }
}

/** The top nav's sections, in order. */
export const SITE_NAV: { label: string; page: SitePage }[] = [
  { label: 'Features', page: { page: 'features' } },
  { label: 'Pricing', page: { page: 'pricing' } },
  { label: 'Docs', page: { page: 'docs', slug: DOCS_HOME } },
  { label: 'Blog', page: { page: 'blog' } },
  { label: 'Company', page: { page: 'about' } },
];

/** Which nav section a page belongs to. */
export function navSection(site: SitePage): string | undefined {
  if (site.page === 'post') return 'Blog';
  if (site.page === 'vision') return 'Company';
  return SITE_NAV.find((item) => item.page.page === site.page)?.label;
}

/** The browser remembers only that it was signed in last time, so `/` does not flash. */
export const SIGNED_IN_HINT = 'yoneda.signedIn';

/**
 * The site page a route shows, or undefined for the app. `/` is the public home for a
 * signed-out visitor; while the session loads, or when it could not be read, `hint` (signed
 * in last time) keeps the app, with its loading and retry states.
 */
export function siteView(
  route: SourceRoute,
  session: { authenticated: boolean; loading: boolean; sessionEnded: boolean; error?: string },
  hint: boolean,
): SitePage | undefined {
  if (route.view === 'site') return route.site;
  if (route.view !== 'home' || session.authenticated || session.sessionEnded) return undefined;
  return (session.loading || session.error) && hint ? undefined : { page: 'home' };
}
