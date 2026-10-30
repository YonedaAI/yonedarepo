// A docs page's headings with unique anchor ids (a repeated heading gets `-2`, `-3`), shared
// by the renderer (each heading's id) and the "On this page" list (the H2s and H3s).
import { anchorId, blocks } from '../../source-platform/markdown';
import { plainText } from './docsContent';

export type DocHeading = { level: number; text: string; id: string };

export function pageHeadings(body: string): DocHeading[] {
  const seen = new Map<string, number>();
  return blocks(body).flatMap((block) => {
    if (block.kind !== 'heading') return [];
    const base = anchorId(plainText(block.text)) || 'section';
    const count = (seen.get(base) ?? 0) + 1;
    seen.set(base, count);
    return [{ level: block.level, text: block.text, id: count > 1 ? `${base}-${count}` : base }];
  });
}

/** The "On this page" entries: the page's second- and third-level headings. */
export const tocOf = (body: string) =>
  pageHeadings(body).filter((h) => h.level <= 3 && h.level >= 2);
