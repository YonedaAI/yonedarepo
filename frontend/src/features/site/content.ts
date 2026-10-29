// The site's written pages: Markdown files under `frontend/src/content`, each opening with a
// small front matter block (`title:`, and `date:`/`summary:` for posts), bundled at build time.

type Page = { title: string; summary: string; body: string; status: string };
export type Post = Page & { slug: string; date: string };

const raw = (files: Record<string, unknown>) => files as Record<string, string>;
const docsFiles = raw(
  import.meta.glob('../../content/docs/**/*.md', { query: '?raw', import: 'default', eager: true }),
);
const blogFiles = raw(
  import.meta.glob('../../content/blog/*.md', { query: '?raw', import: 'default', eager: true }),
);
const legalFiles = raw(
  import.meta.glob('../../content/legal/*.md', { query: '?raw', import: 'default', eager: true }),
);
const companyFiles = raw(
  import.meta.glob('../../content/company/*.md', { query: '?raw', import: 'default', eager: true }),
);

/** Splits `---\nkey: value\n---\nbody` into its fields and body. */
export function frontMatter(source: string): { fields: Record<string, string>; body: string } {
  const match = /^---\n([\s\S]*?)\n---\n?/.exec(source.replace(/\r\n?/g, '\n'));
  if (!match) return { fields: {}, body: source };
  const fields: Record<string, string> = {};
  for (const line of match[1].split('\n')) {
    const at = line.indexOf(':');
    if (at > 0) fields[line.slice(0, at).trim()] = line.slice(at + 1).trim();
  }
  return { fields, body: source.slice(match[0].length) };
}

const page = (source: string): Page => {
  const { fields, body } = frontMatter(source);
  return {
    title: fields.title ?? '',
    summary: fields.summary ?? '',
    status: fields.status ?? '',
    body,
  };
};
// `../../content/docs/guides/cli.md` → `guides/cli`.
const slugOf = (path: string, dir: string) =>
  path.slice(path.indexOf(dir) + dir.length).replace(/\.md$/, '');

export const DOCS_PAGES: Record<string, Page> = Object.fromEntries(
  Object.entries(docsFiles).map(([path, source]) => [slugOf(path, 'content/docs/'), page(source)]),
);

/** The docs' left navigation: every docs file appears exactly once (tested). */
export const DOCS_NAV: { section: string; pages: string[] }[] = [
  { section: 'Get started', pages: ['get-started'] },
  {
    section: 'Guides',
    pages: [
      'guides/repositories',
      'guides/changes',
      'guides/sessions',
      'guides/search',
      'guides/cli',
      'guides/mcp',
      'guides/git-remotes',
    ],
  },
  { section: 'Reference', pages: ['reference/cli', 'reference/api'] },
  { section: 'Security and privacy', pages: ['security'] },
];

/** Posts, newest first. */
export const BLOG_POSTS: Post[] = Object.entries(blogFiles)
  .map(([path, source]) => {
    const { fields } = frontMatter(source);
    return { ...page(source), slug: slugOf(path, 'content/blog/'), date: fields.date ?? '' };
  })
  .sort((a, b) => b.date.localeCompare(a.date) || a.slug.localeCompare(b.slug));

export const COMPANY_PAGES = {
  about: page(companyFiles['../../content/company/about.md'] ?? ''),
  vision: page(companyFiles['../../content/company/vision.md'] ?? ''),
};

/** Terms and Privacy; `status` (front matter) is shown above each, e.g. a draft notice. */
export const LEGAL_PAGES = {
  terms: page(legalFiles['../../content/legal/terms.md'] ?? ''),
  privacy: page(legalFiles['../../content/legal/privacy.md'] ?? ''),
};
