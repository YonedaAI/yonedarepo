import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { PageToolbar } from './PageToolbar';

const row = (props: Parameters<typeof PageToolbar>[0]) =>
  renderToStaticMarkup(createElement(PageToolbar, props));

describe('PageToolbar', () => {
  it('shows the name, or keeps it for screen readers when a filter takes its place', () => {
    expect(row({ title: 'Releases' })).toContain('<h2>Releases</h2>');
    expect(row({ title: 'Landings', view: 'Open' })).toContain('<h2 class="sr-only">Landings</h2>');
  });

  it('offers search and filter only when the page has them', () => {
    const bare = row({ title: 'Tower' });
    expect(bare).not.toContain('toolbar-icon');
    const full = row({
      title: 'Sessions',
      search: { repo: 'r0', navigate: () => {} },
      filters: 'CLI',
    });
    expect(full).toContain('Search this repository');
    expect(full).toContain('aria-label="Filter"');
  });

  it('counts the filters that are on, and says so to a screen reader', () => {
    const on = row({ title: 'Memories', filters: 'Kind', filtered: 2 });
    expect(on).toContain('aria-label="Filter: 2 on"');
    expect(on).toContain('<span class="toolbar-count">2</span>');
  });
});
