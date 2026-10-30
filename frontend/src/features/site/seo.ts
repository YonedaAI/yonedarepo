// What search engines and link previews see of the public site: each page's title,
// description and structured-data facts, built from the same content the pages render.
// The production build writes it to `dist/_site/routes.json` (vite-prerender.ts), where the
// front Worker reads it to fill each page's head and the sitemap; it never imports React.
import { BLOG_POSTS, COMPANY_PAGES, LEGAL_PAGES } from './content';
import { DOCS_PAGES, plainText } from './docs/docsContent';
import { FEATURE_PAGES, featureItemOf, featurePageAt } from './featurePages';
import { MARGIN } from './pricing';
import { DOCS_HOME, formatSitePage, type SitePage } from './siteRoute';

/** index.html's own description: the home page's, and any page's without one. */
export const DEFAULT_DESCRIPTION =
  'Git-compatible hosting where agents and people commit, review and land on the server. Every session’s context stays with the code.';
const HOME_TITLE = 'YonedaRepo — The Git platform built for agents';

export type SeoRoute = {
  path: string;
  /** The page's own name (a post's headline); `title` is the browser tab's. */
  name: string;
  title: string;
  description: string;
  /** Which structured data the page carries (front Worker, seo-head.ts). */
  kind: 'home' | 'post' | 'docs' | 'page';
  /** Listed in sitemap.xml (sign-in pages are not). */
  sitemap: boolean;
  /** A post's front matter: date, author and hero image path. */
  published?: string;
  author?: string;
  image?: string;
  breadcrumbs?: { name: string; path: string }[];
};
export type SeoManifest = {
  routes: SeoRoute[];
  /** Another address of a page (`/company` → `/company/about`), by its canonical path. */
  aliases: Record<string, string>;
};

/** A page's own name: the sign-in heading, and its document title before the suffix. */
export function pageTitle(site: SitePage): string {
  switch (site.page) {
    case 'home':
      return HOME_TITLE;
    case 'features':
      return 'Features';
    case 'feature': {
      const page = featurePageAt(site.slug);
      return (page && featureItemOf(page)?.title) ?? 'Features';
    }
    case 'pricing':
      return 'Pricing';
    case 'docs':
      return DOCS_PAGES[site.slug]?.title ?? 'Page not found';
    case 'blog':
      return 'Blog';
    case 'post':
      return BLOG_POSTS.find((p) => p.slug === site.slug)?.title ?? 'Blog';
    case 'about':
    case 'vision':
      return COMPANY_PAGES[site.page].title;
    case 'legal':
      return LEGAL_PAGES[site.doc].title;
    case 'signin':
      return site.mode === 'login' ? 'Sign in' : 'Create your account';
  }
}

/** The browser tab's title for a site page. */
export function documentTitle(site: SitePage): string {
  if (site.page === 'home') return HOME_TITLE;
  if (site.page === 'docs') return `${pageTitle(site)} — YonedaRepo Docs`;
  return `${pageTitle(site)} — YonedaRepo`;
}

const describe = (text: string) => plainText(text).trim() || DEFAULT_DESCRIPTION;

function route(site: SitePage, description: string, extra: Partial<SeoRoute> = {}): SeoRoute {
  return {
    path: formatSitePage(site),
    name: pageTitle(site),
    title: documentTitle(site),
    description: describe(description),
    kind: 'page',
    sitemap: true,
    ...extra,
  };
}

/** Every public site page, with the address variants that show one of them. */
export function seoManifest(): SeoManifest {
  const margin = Math.round((MARGIN - 1) * 100);
  const routes: SeoRoute[] = [
    route({ page: 'home' }, DEFAULT_DESCRIPTION, { kind: 'home' }),
    route(
      { page: 'features' },
      'What the platform does today. Each feature works the same from stock Git, the web app, the CLI, the API and MCP.',
    ),
    ...FEATURE_PAGES.map((page) => route({ page: 'feature', slug: page.slug }, page.headline)),
    route(
      { page: 'pricing' },
      `Every platform feature is free. Metered usage is billed at our provider's list cost plus ${margin}%.`,
    ),
    ...Object.values(DOCS_PAGES).map((page) => {
      const site: SitePage = { page: 'docs', slug: page.slug };
      const crumbs = [{ name: 'Docs', path: formatSitePage({ page: 'docs', slug: DOCS_HOME }) }];
      if (page.slug !== DOCS_HOME) crumbs.push({ name: page.title, path: formatSitePage(site) });
      return route(site, page.summary, { kind: 'docs', breadcrumbs: crumbs });
    }),
    route(
      { page: 'blog' },
      'Notes and research from building YonedaRepo, with the numbers we measured.',
    ),
    ...BLOG_POSTS.map((post) =>
      route({ page: 'post', slug: post.slug }, post.summary, {
        kind: 'post',
        published: post.date,
        author: post.author,
        image: post.image,
      }),
    ),
    route({ page: 'about' }, COMPANY_PAGES.about.summary),
    route({ page: 'vision' }, COMPANY_PAGES.vision.summary),
    route({ page: 'legal', doc: 'terms' }, LEGAL_PAGES.terms.summary),
    route({ page: 'legal', doc: 'privacy' }, LEGAL_PAGES.privacy.summary),
    route({ page: 'signin', mode: 'login' }, '', { sitemap: false }),
    route({ page: 'signin', mode: 'signup' }, '', { sitemap: false }),
  ];
  return {
    routes,
    aliases: {
      [`/docs/${DOCS_HOME}`]: formatSitePage({ page: 'docs', slug: DOCS_HOME }),
      '/company': formatSitePage({ page: 'about' }),
    },
  };
}
