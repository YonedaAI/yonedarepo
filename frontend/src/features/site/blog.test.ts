// The blog: every post's front matter and hero image, the category filter, "More posts",
// figures in a body, and the index and post pages as rendered.
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { formatSourceRoute, parseSourceRoute } from '../source-platform/sourceRoute';
import {
  BLOG_CATEGORIES,
  bodyParts,
  categoryFromHash,
  filterPosts,
  morePosts,
  readingMinutes,
  usedCategories,
} from './blog';
import { BLOG_POSTS } from './content';
import { SiteBlog } from './SiteBlog';

const navigate = () => {};
const render = (element: React.ReactElement) => renderToStaticMarkup(element);
// The files under `frontend/public/blog`, as served paths (`/blog/<slug>/hero.svg`).
const PUBLIC = Object.keys(
  import.meta.glob('../../../public/blog/*/*', { query: '?url', import: 'default' }),
).map((path) => path.slice(path.indexOf('/blog/')));
const words = (text: string) => text.split(/\s+/).filter(Boolean).length;

describe('blog posts', () => {
  it.each(BLOG_POSTS.map((p) => p.slug))('%s has its front matter and hero image', (slug) => {
    const [post] = BLOG_POSTS.filter((p) => p.slug === slug);
    expect(BLOG_CATEGORIES).toContain(post.category);
    expect(post.author).not.toBe('');
    expect(post.summary.length).toBeGreaterThan(40);
    expect(post.image).toMatch(new RegExp(`^/blog/${slug}/[\\w-]+\\.(webp|png|svg)$`));
    expect(PUBLIC).toContain(post.image);
    expect(post.imageAlt.length).toBeGreaterThan(20);
    expect(post.caption).not.toBe('');
  });

  it('draws each research post from a paper, at 600 to 1,200 words', () => {
    const research = BLOG_POSTS.filter((p) => p.category === 'Research');
    expect(research.length).toBeGreaterThanOrEqual(5);
    for (const post of research) {
      expect(post.paper).toMatch(/^https:\/\/yonedarepo-research\.vercel\.app\/papers\/[a-z-]+\/$/);
      expect(post.body).toContain(post.paper.replace(/\/$/, ''));
      expect(words(post.body)).toBeGreaterThanOrEqual(600);
      expect(words(post.body)).toBeLessThanOrEqual(1200);
    }
  });

  it('orders one date by `order`, so a series reads in its order', () => {
    const series = BLOG_POSTS.filter((p) => p.category === 'Research').map((p) => p.order);
    expect(series).toEqual([...series].sort((a, b) => a - b));
  });

  it('links only to posts that exist', () => {
    const slugs = new Set(BLOG_POSTS.map((p) => p.slug));
    for (const post of BLOG_POSTS)
      for (const [, slug] of post.body.matchAll(/\]\(\/blog\/([a-z0-9-]+)\)/g))
        expect(slugs, `${post.slug} links /blog/${slug}`).toContain(slug);
  });

  it.each(BLOG_POSTS.map((p) => p.slug))('routes /blog/%s', (slug) => {
    const route = parseSourceRoute(`/blog/${slug}`, '');
    expect(route).toEqual({ view: 'site', site: { page: 'post', slug } });
    expect(formatSourceRoute(route)).toBe(`/blog/${slug}`);
  });
});

describe('blog filter', () => {
  it.each([
    ['#research', 'Research'],
    ['#Engineering', 'Engineering'],
    ['research', 'Research'],
    ['', undefined],
    ['#', undefined],
    ['#nope', undefined],
    ['#%E2%80%A6', undefined],
  ])('reads %j as %s', (hash, category) => {
    expect(categoryFromHash(hash)).toBe(category);
  });

  it('shows a chip only for a category with posts, in filter order', () => {
    const used = usedCategories(BLOG_POSTS);
    expect(used).toEqual(BLOG_CATEGORIES.filter((c) => used.includes(c)));
    for (const category of used)
      expect(filterPosts(BLOG_POSTS, category).length).toBeGreaterThan(0);
    expect(used).toEqual(['Research', 'Engineering']);
  });

  it('keeps every post for all, and only one category otherwise', () => {
    expect(filterPosts(BLOG_POSTS, undefined)).toEqual(BLOG_POSTS);
    const research = filterPosts(BLOG_POSTS, 'Research');
    expect(research.every((p) => p.category === 'Research')).toBe(true);
    expect(research.length).toBe(BLOG_POSTS.filter((p) => p.category === 'Research').length);
  });
});

describe('more posts and reading time', () => {
  it('picks three others, the same category first', () => {
    for (const post of BLOG_POSTS) {
      const more = morePosts(BLOG_POSTS, post);
      expect(more).toHaveLength(3);
      expect(more.map((p) => p.slug)).not.toContain(post.slug);
      const same = BLOG_POSTS.filter((p) => p.category === post.category).length - 1;
      expect(more.slice(0, Math.min(3, same)).every((p) => p.category === post.category)).toBe(
        true,
      );
    }
  });

  it('reads at 230 words a minute, at least one', () => {
    expect(readingMinutes('')).toBe(1);
    expect(readingMinutes('word '.repeat(230))).toBe(1);
    expect(readingMinutes('word '.repeat(231))).toBe(2);
  });
});

describe('figures in a body', () => {
  it('splits out an image alone on its line from the blog folder', () => {
    const parts = bodyParts('Intro.\n\n![A diagram](/blog/x/fig.webp "The caption")\n\nAfter.\n');
    expect(parts).toEqual([
      { kind: 'markdown', source: 'Intro.\n' },
      { kind: 'figure', src: '/blog/x/fig.webp', alt: 'A diagram', caption: 'The caption' },
      { kind: 'markdown', source: '\nAfter.\n' },
    ]);
  });

  it('leaves other images, inline images and fenced ones as text', () => {
    for (const body of [
      '![remote](https://example.com/a.png)',
      'See ![a](/blog/x/a.png) inline.',
      '![escape](/blog/../secret.png)',
      '```\n![a](/blog/x/a.png)\n```',
    ])
      expect(bodyParts(body).every((part) => part.kind === 'markdown')).toBe(true);
  });
});

describe('blog pages', () => {
  it('features the newest post, then three cards, then every post', () => {
    const html = render(createElement(SiteBlog, { navigate }));
    const [featured, ...rest] = BLOG_POSTS;
    const at = (slug: string) => html.indexOf(`href="/blog/${slug}"`);
    expect(at(featured.slug)).toBeGreaterThan(-1);
    expect(html.indexOf('blog-featured')).toBeLessThan(html.indexOf('blog-row'));
    for (const post of rest.slice(0, 3)) expect(at(post.slug)).toBeGreaterThan(at(featured.slug));
    const list = html.slice(html.indexOf('class="blog-list"'));
    for (const post of BLOG_POSTS) expect(list).toContain(`href="/blog/${post.slug}"`);
    expect(html).toContain('href="/blog#research"');
    expect(html).not.toContain('href="/blog#company"');
    expect(html).toMatch(/href="\/blog" aria-current="true">All articles/);
  });

  it('lists only the chosen category under the filter', () => {
    const html = render(createElement(SiteBlog, { navigate, category: 'Engineering' }));
    expect(html).toMatch(/href="\/blog#engineering" aria-current="true"/);
    const list = html.slice(html.indexOf('class="blog-list"'));
    for (const post of BLOG_POSTS)
      if (post.category === 'Engineering') expect(list).toContain(`href="/blog/${post.slug}"`);
      else expect(list).not.toContain(`href="/blog/${post.slug}"`);
  });

  it.each(BLOG_POSTS.map((p) => p.slug))('renders post %s with its hero and more posts', (slug) => {
    const [post] = BLOG_POSTS.filter((p) => p.slug === slug);
    const html = render(createElement(SiteBlog, { slug, navigate }));
    expect(html).toContain(`src="${post.image}"`);
    expect(html).toContain(`<figcaption>`);
    expect(html).toContain(`${readingMinutes(post.body)} min read`);
    expect(html).toContain('More posts');
    const more = html.slice(html.indexOf('More posts'));
    for (const other of morePosts(BLOG_POSTS, post))
      expect(more).toContain(`href="/blog/${other.slug}"`);
  });

  it('answers an unknown post with a not-found heading', () => {
    expect(render(createElement(SiteBlog, { slug: 'nope', navigate }))).toContain('Post not found');
  });
});
