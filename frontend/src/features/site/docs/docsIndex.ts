// Docs search, wholly in the browser: an index of every page's sections (its title, then
// each heading with the text under it), built once from the bundled pages, and a ranked
// lookup in which every word of the query must appear in the section.
import { blocks } from '../../source-platform/markdown';
import { DOCS_PAGES, type DocPage, parseCards, plainText } from './docsContent';
import { pageHeadings } from './docsHeadings';
import { DOCS_ORDER } from './docsNav';

export type SearchEntry = {
  slug: string;
  page: string;
  /** The section's heading, or empty for the page's opening (before its first heading). */
  heading: string;
  /** The heading's anchor id, or empty for the page's opening. */
  anchor: string;
  text: string;
};
export type SearchHit = SearchEntry & { snippet: string; score: number };

/** One page's sections. */
export function pageEntries(page: DocPage): SearchEntry[] {
  const headings = pageHeadings(page.body);
  const out: SearchEntry[] = [
    { slug: page.slug, page: page.title, heading: '', anchor: '', text: page.summary },
  ];
  let h = 0;
  for (const block of blocks(page.body)) {
    const current = out[out.length - 1];
    if (block.kind === 'heading') {
      const { id, text } = headings[h++];
      out.push({
        slug: page.slug,
        page: page.title,
        heading: plainText(text),
        anchor: id,
        text: '',
      });
      continue;
    }
    const words =
      block.kind === 'code'
        ? block.lang === 'cards'
          ? parseCards(block.text)
              .map((c) => `${c.title}. ${c.text}`)
              .join(' ')
          : block.text
        : block.kind === 'list'
          ? block.items.join(' ')
          : block.kind === 'table'
            ? [block.head, ...block.rows].flat().join(' ')
            : block.kind === 'rule'
              ? ''
              : block.text;
    current.text = `${current.text} ${plainText(words)}`.trim();
  }
  return out;
}

export const SEARCH_INDEX: SearchEntry[] = DOCS_ORDER.flatMap((slug) =>
  DOCS_PAGES[slug] ? pageEntries(DOCS_PAGES[slug]) : [],
);

const words = (query: string) => query.toLowerCase().split(/\s+/).filter(Boolean);

/** A short excerpt of `text` around the first query word it holds. */
function snippetOf(text: string, terms: string[]): string {
  const lower = text.toLowerCase();
  const at = Math.min(...terms.map((t) => lower.indexOf(t)).filter((i) => i >= 0));
  if (!Number.isFinite(at)) return text.slice(0, 120);
  const start = Math.max(0, at - 40);
  const end = Math.min(text.length, at + 100);
  return `${start > 0 ? '…' : ''}${text.slice(start, end).trim()}${end < text.length ? '…' : ''}`;
}

/**
 * Sections holding every word of the query, best first: words in the page title count most,
 * then in the heading, then in the text; ties keep reading order. At most `limit` hits.
 */
export function searchDocs(query: string, limit = 12, index = SEARCH_INDEX): SearchHit[] {
  const terms = words(query);
  if (!terms.length) return [];
  const hits: SearchHit[] = [];
  index.forEach((entry, order) => {
    const page = entry.page.toLowerCase();
    const heading = entry.heading.toLowerCase();
    const text = entry.text.toLowerCase();
    let score = 0;
    for (const term of terms) {
      const inPage = page.includes(term);
      const inHeading = heading.includes(term);
      const inText = text.includes(term);
      if (!inPage && !inHeading && !inText) return;
      score += (inPage ? 8 : 0) + (inHeading ? 4 : 0) + (inText ? 1 : 0);
    }
    // A page's own opening outranks its sections when the title matches.
    if (!entry.heading && terms.every((t) => page.includes(t))) score += 4;
    hits.push({ ...entry, score: score - order / 1e6, snippet: snippetOf(entry.text, terms) });
  });
  return hits.sort((a, b) => b.score - a.score).slice(0, limit);
}
