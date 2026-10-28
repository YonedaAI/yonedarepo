// The sidebar's repository and organization links: each is named "<name>, <label>" for
// assistive technology, never the name and its small label run together.
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { labelled, WorkspaceRail } from './WorkspaceRail';

describe('workspace rail', () => {
  it('names a row with its label, and leaves an unlabelled row to its text', () => {
    expect(labelled('acme', 'owner')).toBe('acme, owner');
    expect(labelled('mine')).toBeUndefined();
  });

  it('labels repository and organization links', () => {
    const html = renderToStaticMarkup(
      createElement(WorkspaceRail, {
        authenticated: true,
        loading: false,
        rows: [
          { repo: 'r0000000000000000000a', name: 'shared', shared: 'ada · write' },
          { repo: 'r0000000000000000000b', name: 'mine' },
        ],
        orgs: [{ org: 'acme', role: 'owner' }],
      }),
    );
    expect(html).toContain('aria-label="shared, ada · write"');
    expect(html).toContain('aria-label="acme, owner"');
    expect(html).not.toContain('aria-label="mine');
    // The visible name stays in its own element (the browser gate finds org rows by it).
    expect(html).toContain('<span class="rail-repo-name">acme</span>');
  });
});
