import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { isMarkdown, PreviewToggle } from './FilePreview';
import { RepoMarkdown } from './RepoMarkdown';

describe('a Markdown file', () => {
  it('is known by its name', () => {
    expect(['README.md', 'docs/a.MARKDOWN', 'b.mdx'].every(isMarkdown)).toBe(true);
    expect(['md', 'a.md.txt', 'a.txt'].some(isMarkdown)).toBe(false);
  });

  it('renders, and says which view is on', () => {
    const place = { repo: 'r0', ref: 'main', path: 'README.md' };
    const read = createElement(RepoMarkdown, { source: '# Hi', place });
    expect(renderToStaticMarkup(read)).toContain('Hi</h');
    const html = renderToStaticMarkup(
      createElement(PreviewToggle, { preview: true, onChange: () => {} }),
    );
    expect(html).toContain('aria-pressed="true">Preview');
    expect(html).toContain('aria-pressed="false">Code');
  });
});
