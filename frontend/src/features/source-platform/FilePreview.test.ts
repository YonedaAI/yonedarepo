import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { FilePreview, isMarkdown, PreviewToggle } from './FilePreview';

describe('a Markdown file', () => {
  it('is known by its name', () => {
    expect(['README.md', 'docs/a.MARKDOWN', 'b.mdx'].every(isMarkdown)).toBe(true);
    expect(['md', 'a.md.txt', 'a.txt'].some(isMarkdown)).toBe(false);
  });

  it('renders, and says which view is on', () => {
    expect(renderToStaticMarkup(createElement(FilePreview, { content: '# Hi' }))).toContain(
      'Hi</h',
    );
    const html = renderToStaticMarkup(
      createElement(PreviewToggle, { preview: true, onChange: () => {} }),
    );
    expect(html).toContain('aria-pressed="true">Preview');
    expect(html).toContain('aria-pressed="false">Code');
  });
});
