// What crawlers and link previews get from the front Worker: each page's own head (from the
// build's route manifest, seo.ts), prerendered site pages, public repository pages, noindex on
// app pages, and robots.txt / sitemap.xml that index production only.
import { expect, it } from 'vitest';
import { frontFetch } from '../../cloudflare/worker/front-routes';
import { platformFetch } from '../../cloudflare/worker/platform-routes';
import type { Env } from '../../cloudflare/worker/types';
import { api, author, file, scoped, signup, usePlatformFixture } from './repo-fixture';

usePlatformFixture();

const ORIGIN = 'https://yoneda.example';
const template = (body = '') => `<!doctype html><html><head>
<title>YonedaRepo — The Git platform built for agents</title>
<meta name="description" content="Default description.">
<link rel="canonical" href="__YONEDA_PUBLIC_ORIGIN__">
<meta property="og:title" content="YonedaRepo — The Git platform built for agents">
<meta property="og:description" content="Default description.">
<meta property="og:url" content="__YONEDA_PUBLIC_ORIGIN__">
<meta property="og:image" content="__YONEDA_SOCIAL_IMAGE_URL__">
<meta name="twitter:title" content="YonedaRepo — The Git platform built for agents">
<meta name="twitter:description" content="Default description.">
</head><body><div id="root">${body}</div></body></html>`;

const post = {
  path: '/blog/a-post',
  name: 'A post',
  title: 'A post — YonedaRepo',
  description: 'What the post found.',
  kind: 'post',
  sitemap: true,
  published: '2026-10-20',
  author: 'Matthew Long',
  image: '/blog/a-post/cover.webp',
};
const manifest = {
  routes: [
    { path: '/', name: 'YonedaRepo — The Git platform built for agents', title: 'YonedaRepo — The Git platform built for agents', description: 'Default description.', kind: 'home', sitemap: true },
    { path: '/pricing', name: 'Pricing', title: 'Pricing — YonedaRepo', description: 'Every platform feature is free.', kind: 'page', sitemap: true },
    post,
    { path: '/docs', name: 'Introduction', title: 'Introduction — YonedaRepo Docs', description: 'Start here.', kind: 'docs', sitemap: true, breadcrumbs: [{ name: 'Docs', path: '/docs' }] },
    { path: '/docs/guides/pushing', name: 'Concurrent pushes', title: 'Concurrent pushes — YonedaRepo Docs', description: 'Pushes land in order.', kind: 'docs', sitemap: true, breadcrumbs: [{ name: 'Docs', path: '/docs' }, { name: 'Concurrent pushes', path: '/docs/guides/pushing' }] },
    { path: '/company/about', name: 'About Yoneda Labs', title: 'About Yoneda Labs — YonedaRepo', description: 'We build YonedaRepo.', kind: 'page', sitemap: true },
    { path: '/signin', name: 'Sign in', title: 'Sign in — YonedaRepo', description: 'Default description.', kind: 'page', sitemap: false },
  ],
  aliases: { '/company': '/company/about', '/docs/introduction': '/docs' },
};

// The static assets as the build lays them out: the shell, prerendered copies under /_site/.
const asked: string[] = [];
const assets = {
  fetch: async (req: Request) => {
    const { pathname } = new URL(req.url);
    asked.push(pathname);
    if (pathname === '/_site/routes.json') return Response.json(manifest);
    const page: Record<string, string> = {
      '/_site/pricing': '<h1>Free platform. Pay only for what we run.</h1>',
      '/_site/home': '<h1>The Git platform built for agents</h1>',
    };
    return new Response(template(page[pathname]), { headers: { 'content-type': 'text/html; charset=utf-8' } });
  },
};
const local = { ...scoped, PLATFORM_OBJECT_STORE: 'r2', PUBLIC_APP_ORIGIN: ORIGIN, ASSETS: assets } as unknown as Env;
const dev = { ...local, PLATFORM: { fetch: (req: Request) => platformFetch(req, local) } } as unknown as Env;
const prod = { ...dev, SEO_INDEXING: 'on' } as unknown as Env;

async function page(path: string, env: Env = prod) {
  const response = await frontFetch(new Request(`${ORIGIN}${path}`), env);
  const html = await response.text();
  const head: Record<string, string | null> = {};
  const jsonLd: any[] = [];
  let title = '';
  let script = '';
  await new HTMLRewriter()
    .on('title', { text: (t) => void (title += t.text) })
    .on('meta', {
      element(e) {
        const key = e.getAttribute('property') ?? e.getAttribute('name');
        if (key) head[key] = decode(e.getAttribute('content'));
      },
    })
    .on('link[rel="canonical"]', { element: (e) => void (head.canonical = decode(e.getAttribute('href'))) })
    .on('script[type="application/ld+json"]', {
      text(t) {
        script += t.text;
        if (t.lastInTextNode) {
          jsonLd.push(JSON.parse(script));
          script = '';
        }
      },
    })
    .transform(new Response(html))
    .text();
  return { response, html, head, title: decode(title), jsonLd };
}
const decode = (value: string | null) => value?.replaceAll('&quot;', '"').replaceAll('&amp;', '&') ?? null;

it('gives a site page its own title, description and canonical, from its prerendered copy', async () => {
  for (const path of ['/pricing', '/pricing/', '/pricing?ref=newsletter']) {
    asked.length = 0;
    const { html, head, title, response } = await page(path);
    expect(title, path).toBe('Pricing — YonedaRepo');
    expect(head, path).toMatchObject({
      description: 'Every platform feature is free.',
      canonical: `${ORIGIN}/pricing`,
      'og:url': `${ORIGIN}/pricing`,
      'og:title': 'Pricing — YonedaRepo',
      'og:description': 'Every platform feature is free.',
      'twitter:title': 'Pricing — YonedaRepo',
      'twitter:description': 'Every platform feature is free.',
      'og:image': `${ORIGIN}/brand/social-card.png`,
    });
    expect(head.robots, path).toBeUndefined();
    expect(html, path).toContain('<h1>Free platform. Pay only for what we run.</h1>');
    expect(asked, path).toContain('/_site/pricing');
    expect(response.headers.get('x-robots-tag'), path).toBeNull();
  }
  // Another address of a page names the page as canonical.
  const about = await page('/company');
  expect([about.title, about.head.canonical]).toEqual(['About Yoneda Labs — YonedaRepo', `${ORIGIN}/company/about`]);
  // The copies are the Worker's to serve, never their own pages.
  expect((await frontFetch(new Request(`${ORIGIN}/_site/pricing`), prod)).status).toBe(404);
});

it('describes a blog post from its front matter, and the home and docs with structured data', async () => {
  const blog = await page('/blog/a-post');
  expect(blog.title).toBe('A post — YonedaRepo');
  expect(blog.head.description).toBe('What the post found.');
  expect(blog.jsonLd).toEqual([
    {
      '@context': 'https://schema.org',
      '@type': 'BlogPosting',
      headline: 'A post',
      description: 'What the post found.',
      datePublished: '2026-10-20',
      author: { '@type': 'Person', name: 'Matthew Long' },
      image: `${ORIGIN}/blog/a-post/cover.webp`,
      url: `${ORIGIN}/blog/a-post`,
      mainEntityOfPage: `${ORIGIN}/blog/a-post`,
      publisher: { '@type': 'Organization', name: 'Yoneda Labs', url: `${ORIGIN}/`, logo: `${ORIGIN}/brand/mark.svg` },
    },
  ]);

  const home = await page('/');
  expect(home.html).toContain('<h1>The Git platform built for agents</h1>');
  expect(home.head.canonical).toBe(`${ORIGIN}/`);
  expect(home.jsonLd.map((d) => d['@type'])).toEqual(['Organization', 'SoftwareApplication']);
  expect(home.jsonLd[0]).toMatchObject({ name: 'Yoneda Labs', url: `${ORIGIN}/`, logo: `${ORIGIN}/brand/mark.svg` });
  expect(home.jsonLd[1]).toMatchObject({ name: 'YonedaRepo', url: `${ORIGIN}/`, applicationCategory: 'DeveloperApplication' });

  const docs = await page('/docs/guides/pushing');
  expect(docs.title).toBe('Concurrent pushes — YonedaRepo Docs');
  expect(docs.jsonLd).toEqual([
    {
      '@context': 'https://schema.org',
      '@type': 'BreadcrumbList',
      itemListElement: [
        { '@type': 'ListItem', position: 1, name: 'Docs', item: `${ORIGIN}/docs` },
        { '@type': 'ListItem', position: 2, name: 'Concurrent pushes', item: `${ORIGIN}/docs/guides/pushing` },
      ],
    },
  ]);
});

it('marks signed-in app pages noindex and names a public repository, never a private one', async () => {
  for (const path of ['/settings', '/agents', '/admin', '/source/explore']) {
    const app = await page(path);
    expect(app.head.robots, path).toBe('noindex');
    expect(app.head.canonical, path).toBeUndefined();
    expect(app.title, path).toBe('YonedaRepo — The Git platform built for agents');
  }

  const cookie = await signup('seo_owner');
  const made = (name: string, visibility: string) =>
    api('/repos', { cookie }, { body: { name, visibility, policy: { required_checks: [], approvals: 0 }, files: [file('README.md', '# x\n')], author } }, local);
  expect((await made('Open', 'public')).status).toBe(200);
  expect((await made('hidden-plans', 'private')).status).toBe(200);

  const open = await page('/seo_owner/open');
  expect(open.title).toBe('seo_owner/Open · YonedaRepo');
  expect(open.head).toMatchObject({
    canonical: `${ORIGIN}/seo_owner/Open`,
    'og:url': `${ORIGIN}/seo_owner/Open`,
    'og:title': 'seo_owner/Open · YonedaRepo',
    description: 'seo_owner/Open, a public repository on YonedaRepo.',
  });
  expect(open.head.robots).toBeUndefined();

  for (const path of ['/seo_owner/hidden-plans', '/seo_owner/nothing-here', '/nobody_here/open']) {
    const hidden = await page(path);
    expect(hidden.head.robots, path).toBe('noindex');
    expect(hidden.head.canonical, path).toBeUndefined();
    expect(hidden.html, path).not.toContain('hidden-plans');
    expect(hidden.title, path).toBe('YonedaRepo — The Git platform built for agents');
  }
});

it('lets production be indexed and keeps dev out of every index', async () => {
  const robots = async (env: Env) => (await frontFetch(new Request(`${ORIGIN}/robots.txt`), env)).text();
  const prodRobots = await robots(prod);
  expect(prodRobots).toContain('Allow: /\n');
  for (const line of ['Disallow: /api/', 'Disallow: /settings$', 'Disallow: /admin$', 'Disallow: /auth/', 'Disallow: /source/', `Sitemap: ${ORIGIN}/sitemap.xml`])
    expect(prodRobots).toContain(line);
  expect(await robots(dev)).toBe('User-agent: *\nDisallow: /\n');

  const devPage = await page('/pricing', dev);
  expect(devPage.response.headers.get('x-robots-tag')).toBe('noindex');
  expect(devPage.head.robots).toBe('noindex');
});

it('lists site pages and public repositories in the sitemap, never a private one', async () => {
  const cookie = await signup('map_owner');
  const made = (name: string, visibility: string) =>
    api('/repos', { cookie }, { body: { name, visibility, policy: { required_checks: [], approvals: 0 }, files: [file('README.md', '# x\n')], author } }, local);
  await made('mapped', 'public');
  await made('unmapped-secret', 'private');

  const response = await frontFetch(new Request(`${ORIGIN}/sitemap.xml`), prod);
  expect(response.headers.get('content-type')).toContain('application/xml');
  const xml = await response.text();
  expect(xml).toMatch(/^<\?xml version="1.0" encoding="UTF-8"\?>\n<urlset xmlns="http:\/\/www.sitemaps.org\/schemas\/sitemap\/0.9">/);
  for (const path of ['/', '/pricing', '/blog/a-post', '/docs/guides/pushing', '/map_owner/mapped'])
    expect(xml, path).toContain(`<loc>${ORIGIN}${path === '/' ? '/' : path}</loc>`);
  expect(xml).toContain('<lastmod>2026-10-20</lastmod>');
  expect(xml).not.toContain('/signin');
  expect(xml).not.toContain('unmapped-secret');
});
