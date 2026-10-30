// The blog's rules, apart from its pages: categories and the `/blog#research` filter,
// reading time, the "More posts" pick, and the figures a post's body may hold.
import type { Post } from './content';

/** Every category a post may name, in the order the filter shows them. */
export const BLOG_CATEGORIES = ['Research', 'Engineering', 'Company', 'Changelog'] as const;

/** `Research` → `research`, the filter's hash. */
export const categorySlug = (category: string) => category.toLowerCase();

/** The categories that have posts, in filter order (an empty one shows no chip). */
export const usedCategories = (posts: Post[]) =>
  BLOG_CATEGORIES.filter((category) => posts.some((post) => post.category === category));

/** The category a hash names (`#research`), or undefined for all posts or an unknown one. */
export function categoryFromHash(hash: string): string | undefined {
  const slug = decodeURIComponent(hash.replace(/^#/, '')).toLowerCase();
  return BLOG_CATEGORIES.find((category) => categorySlug(category) === slug);
}

export const filterPosts = (posts: Post[], category: string | undefined) =>
  category ? posts.filter((post) => post.category === category) : posts;

/** Minutes to read a body at 230 words a minute, at least one. */
export const readingMinutes = (body: string) =>
  Math.max(1, Math.ceil(body.split(/\s+/).filter(Boolean).length / 230));

/** Up to `count` other posts: the same category first, then the rest, each newest first. */
export function morePosts(posts: Post[], current: Post, count = 3): Post[] {
  const others = posts.filter((post) => post.slug !== current.slug);
  return [
    ...others.filter((post) => post.category === current.category),
    ...others.filter((post) => post.category !== current.category),
  ].slice(0, count);
}

export type BodyPart =
  | { kind: 'markdown'; source: string }
  | { kind: 'figure'; src: string; alt: string; caption: string };

// A figure is an image alone on its line, served from the blog's own folder:
// `![alt](/blog/<slug>/name.webp "caption")`, outside a code fence. Any other image stays
// text, as in a README.
const FIGURE =
  /^!\[([^\]]*)\]\((\/blog\/[a-z0-9-]+\/[\w.-]+\.(?:webp|png|svg|jpg))(?:\s+"([^"]*)")?\)\s*$/;

/** A post's body as Markdown runs and the figures between them. */
export function bodyParts(body: string): BodyPart[] {
  const parts: BodyPart[] = [];
  let run: string[] = [];
  let fenced = false;
  const flush = () => {
    if (run.join('').trim()) parts.push({ kind: 'markdown', source: run.join('\n') });
    run = [];
  };
  for (const line of body.replace(/\r\n?/g, '\n').split('\n')) {
    if (/^\s{0,3}(```|~~~)/.test(line)) fenced = !fenced;
    const figure = fenced ? null : FIGURE.exec(line.trim());
    if (!figure) {
      run.push(line);
      continue;
    }
    flush();
    parts.push({ kind: 'figure', alt: figure[1], src: figure[2], caption: figure[3] ?? '' });
  }
  flush();
  return parts;
}
