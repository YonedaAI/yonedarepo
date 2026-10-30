// The site's route manifest (seo.ts): what the front Worker puts in each page's head and sitemap.
import { describe, expect, it } from 'vitest';
import { BLOG_POSTS } from './content';
import { DOCS_PAGES } from './docs/docsContent';
import { FEATURE_PAGES } from './featurePages';
import { DEFAULT_DESCRIPTION, documentTitle, seoManifest } from './seo';
import { parseSitePath } from './siteRoute';

const manifest = seoManifest();
const at = (path: string) => manifest.routes.find((r) => r.path === path);

describe('seo manifest', () => {
  it('gives each site page its own title, description and clean path', () => {
    expect(at('/')).toMatchObject({
      title: 'YonedaRepo — The Git platform built for agents',
      description: DEFAULT_DESCRIPTION,
      kind: 'home',
    });
    expect(at('/pricing')).toMatchObject({
      title: 'Pricing — YonedaRepo',
      description: expect.stringContaining('list cost plus 30%'),
    });
    expect(at('/terms')?.description).not.toContain('{{');
    const paths = manifest.routes.map((r) => r.path);
    expect(new Set(paths).size).toBe(paths.length);
    for (const path of paths.filter((p) => p !== '/')) {
      expect(parseSitePath(path.split('/').filter(Boolean)), path).toBeDefined();
      expect(path).not.toMatch(/\/$/);
    }
    for (const route of manifest.routes) expect(route.description, route.path).not.toBe('');
  });

  it('lists every feature page, docs page and blog post', () => {
    for (const page of FEATURE_PAGES) expect(at(`/features/${page.slug}`)).toBeDefined();
    for (const slug of Object.keys(DOCS_PAGES))
      expect(at(slug === 'introduction' ? '/docs' : `/docs/${slug}`), slug).toBeDefined();
    expect(manifest.routes.filter((r) => r.kind === 'post')).toHaveLength(BLOG_POSTS.length);
  });

  it('describes a blog post from its front matter', () => {
    const post = BLOG_POSTS[0];
    expect(at(`/blog/${post.slug}`)).toMatchObject({
      name: post.title,
      title: `${post.title} — YonedaRepo`,
      kind: 'post',
      published: post.date,
      author: post.author,
      image: post.image,
    });
    expect(at(`/blog/${post.slug}`)?.description).not.toMatch(/[`*]/);
  });

  it('gives docs pages a breadcrumb trail and the docs title', () => {
    const route = at('/docs/guides/pushing');
    expect(route?.title).toBe(`${DOCS_PAGES['guides/pushing'].title} — YonedaRepo Docs`);
    expect(route?.breadcrumbs).toEqual([
      { name: 'Docs', path: '/docs' },
      { name: DOCS_PAGES['guides/pushing'].title, path: '/docs/guides/pushing' },
    ]);
  });

  it('maps alternate addresses to their canonical page and keeps sign-in out of the sitemap', () => {
    expect(manifest.aliases).toEqual({
      '/docs/introduction': '/docs',
      '/company': '/company/about',
    });
    expect(at('/signin')?.sitemap).toBe(false);
    expect(at('/pricing')?.sitemap).toBe(true);
  });

  it('is the title the browser shows once the app runs', () => {
    expect(documentTitle({ page: 'pricing' })).toBe(at('/pricing')?.title);
    expect(documentTitle({ page: 'home' })).toBe(at('/')?.title);
  });
});
