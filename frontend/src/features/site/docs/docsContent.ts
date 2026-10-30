// The docs pages: Markdown files under `frontend/src/content/docs`, each opening with front
// matter (`title:`, `summary:`), bundled at build time. Besides plain Markdown a page may use
// `> [!NOTE]` / `> [!WARNING]` callouts and a ```cards block (one card per line:
// `icon | title | text | /docs/link`), which the docs renderer draws.

import { blocks } from '../../source-platform/markdown';
import { frontMatter } from '../content';

export type DocPage = { slug: string; title: string; summary: string; body: string };
export type DocCard = { icon: string; title: string; text: string; href: string };

const files = import.meta.glob('../../../content/docs/**/*.md', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

// `../../../content/docs/guides/cli.md` → `guides/cli`.
const slugOf = (path: string) =>
  path.slice(path.indexOf('content/docs/') + 'content/docs/'.length).replace(/\.md$/, '');

export const DOCS_PAGES: Record<string, DocPage> = Object.fromEntries(
  Object.entries(files).map(([path, source]) => {
    const slug = slugOf(path);
    const { fields, body } = frontMatter(source);
    return [slug, { slug, title: fields.title ?? '', summary: fields.summary ?? '', body }];
  }),
);

/** A ```cards block's lines as cards; a line without four fields is skipped. */
export function parseCards(text: string): DocCard[] {
  return text
    .split('\n')
    .map((line) => line.split('|').map((part) => part.trim()))
    .filter((parts) => parts.length === 4 && parts.every(Boolean))
    .map(([icon, title, text, href]) => ({ icon, title, text, href }));
}

export const CALLOUT = /^\[!(NOTE|TIP|WARNING)\]\s*/i;

/** Markdown with docs syntax spelled out as plain Markdown: cards become a link list. */
function plainBody(body: string): string {
  return body.replace(/^```cards\n([\s\S]*?)\n```$/gm, (_all, text: string) =>
    parseCards(text)
      .map((card) => `- [${card.title}](${card.href}): ${card.text}`)
      .join('\n'),
  );
}

/** The page as one Markdown document, for "Copy page". */
export function pageMarkdown(page: DocPage): string {
  const summary = page.summary ? `${page.summary}\n\n` : '';
  return `# ${page.title}\n\n${summary}${plainBody(page.body).trim()}\n`;
}

/** Inline Markdown reduced to its words: code, emphasis and link syntax removed. */
export function plainText(text: string): string {
  return text
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/(\*\*|__|`+)/g, '')
    .replace(/(^|\s)[*_]([^*_\s][^*_]*)[*_]/g, '$1$2')
    .replace(CALLOUT, '');
}

/** Every same-site link a page's body makes (`/docs/x#y`, `/pricing`), cards included. */
export function pageLinks(page: DocPage): string[] {
  const links = [...plainBody(page.body).matchAll(/\]\((\/[^)\s]*)\)/g)].map((m) => m[1]);
  // Code shows links as text; only links outside code blocks count.
  const code = blocks(page.body)
    .filter((b) => b.kind === 'code' && b.lang !== 'cards')
    .map((b) => (b.kind === 'code' ? b.text : ''))
    .join('\n');
  return links.filter((link) => !code.includes(`](${link})`));
}
