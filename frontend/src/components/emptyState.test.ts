import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { EmptyState } from './EmptyState';

describe('the shared empty state', () => {
  it('is a title alone when there is nothing more to say', () => {
    const html = renderToStaticMarkup(createElement(EmptyState, { title: 'No sessions yet' }));
    expect(html).toBe('<div class="empty-state"><h2>No sessions yet</h2></div>');
  });

  it('adds its sentences and its one action below the title', () => {
    const action = createElement('button', { type: 'button' }, 'New repository');
    const html = renderToStaticMarkup(
      createElement(EmptyState, { title: 'Nothing here', action }, 'Add the first one.'),
    );
    expect(html).toContain('<p>Add the first one.</p>');
    expect(html).toContain('<div class="empty-state-action"><button');
  });

  it('can stand for the whole page, and announce itself', () => {
    const html = renderToStaticMarkup(
      createElement(EmptyState, { title: 'Gone', level: 1, id: 'gone', role: 'alert' }),
    );
    expect(html).toContain('role="alert"');
    expect(html).toContain('<h1 id="gone">Gone</h1>');
  });
});
