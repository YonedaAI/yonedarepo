// The Search page's states, rendered as the server would; the fan-out itself is in
// searchAll.test.ts, the keyboard and the live results were checked in a browser.
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { SearchAnswer } from '../source-platform/searchModel';
import { SearchPage } from './SearchPage';
import { SearchResults } from './SearchResults';
import { type Outcome, REPO_CAP } from './searchAllModel';

const a = `r${'a'.repeat(20)}`;
const b = `r${'b'.repeat(20)}`;
const repos = [
  { id: a, name: 'acme', created_at: 2, role: 'owner' },
  { id: b, name: 'beta', created_at: 1, role: 'owner' },
];
const page = (props: object) =>
  renderToStaticMarkup(
    createElement(SearchPage, {
      route: { view: 'global-search' },
      authenticated: true,
      repos,
      sessions: [],
      loading: false,
      navigate: () => {},
      onSignIn: () => {},
      onNew: () => {},
      onRetry: () => {},
      ...props,
    }),
  );

const answer: SearchAnswer = {
  results: [
    {
      path: 'src/a.rs',
      hits: 1,
      lines: [{ line: 12, text: 'retry()', ranges: [[0, 5]] }],
    },
  ],
  skipped_files: [],
  skipped_count: 0,
};
const results = (outcomes: Outcome[], props: object = {}) =>
  renderToStaticMarkup(
    createElement(SearchResults, {
      query: 'retry',
      within: undefined,
      targets: [a, b],
      capped: false,
      outcomes,
      names: new Map([
        [a, 'acme'],
        [b, 'beta'],
      ]),
      navigate: () => {},
      onRetry: () => {},
      ...props,
    }),
  );

describe('the Search page', () => {
  it('opens on the box, the repository picker and the empty state', () => {
    const html = page({});
    expect(html).toContain('placeholder="Search..."');
    expect(html).toContain('aria-label="Repository"');
    expect(html).toContain('All repositories');
    expect(html).toContain(`<option value="${a}">acme</option>`);
    expect(html).toContain('Search across your repositories');
    expect(html).toContain('Find commits, sessions and code across all of your repositories.');
  });

  it('shows the chosen repository and the query from the address', () => {
    const html = page({ route: { view: 'global-search', q: 'retry', within: b } });
    expect(html).toContain('value="retry"');
    expect(html).toContain(`<option value="${b}" selected="">beta</option>`);
  });

  it('keeps a linked repository that is not one of the account’s in the picker', () => {
    const other = `r${'c'.repeat(20)}`;
    expect(page({ route: { view: 'global-search', within: other } })).toContain(
      `<option value="${other}" selected="">${other}</option>`,
    );
  });

  it('asks for two characters before searching', () => {
    expect(page({ route: { view: 'global-search', q: 'r' } })).toContain(
      'Type at least 2 characters',
    );
  });

  it('waits for the repositories, and says when they cannot be read', () => {
    const route = { view: 'global-search', q: 'retry' };
    expect(page({ route, loading: true })).toContain('Loading your repositories');
    expect(page({ route, reposError: 'Something went wrong on our side.' })).toContain(
      'Couldn&#x27;t load your repositories.',
    );
  });

  it('offers a first repository to an account without one', () => {
    const html = page({ route: { view: 'global-search', q: 'retry' }, repos: [] });
    expect(html).toContain('You have no repositories to search yet.');
    expect(html).toContain('New repository');
  });

  it('asks a signed-out visitor to sign in', () => {
    const html = page({ authenticated: false, repos: [] });
    expect(html).toContain('Sign in');
    expect(html).toContain('Search across your repositories');
    expect(
      page({ authenticated: false, repos: [], route: { view: 'global-search', q: 'retry' } }),
    ).toContain('Sign in');
  });
});

describe('Search page results', () => {
  it('counts down while repositories answer, and groups what arrived', () => {
    const html = results([{ repo: b, kind: 'found', answer }]);
    expect(html).toContain('Searching… 1 of 2 repositories');
    expect(html).toContain('beta');
    expect(html).not.toContain('acme');
  });

  it('links each matching line to that line of the file', () => {
    const html = results([{ repo: b, kind: 'found', answer }]);
    expect(html).toContain(`href="/source/${b}/files/src/a.rs?line=12"`);
    expect(html).toContain(`href="/source/${b}/files/src/a.rs"`);
  });

  it('groups by repository in the order they answered, each linking to its own search', () => {
    const html = results([
      { repo: b, kind: 'found', answer },
      { repo: a, kind: 'found', answer },
    ]);
    expect(html.indexOf('beta')).toBeLessThan(html.indexOf('acme'));
    expect(html).toContain(`href="/search?q=retry&amp;repo=${a}"`);
    expect(html).toContain('Found in 2 of 2 repositories.');
  });

  it('shows a failed repository as a notice beside the others', () => {
    const html = results([
      { repo: b, kind: 'found', answer },
      { repo: a, kind: 'failed', error: 'Something went wrong on our side.' },
    ]);
    expect(html).toContain('search-failed');
    expect(html).toContain('Couldn’t search');
    expect(html).toContain(`href="/search?q=retry&amp;repo=${a}"`);
    expect(html).toContain(`href="/source/${b}/files/src/a.rs?line=12"`);
    expect(html).not.toContain('role="alert"');
  });

  it('says when nothing matched, leaving out repositories with nothing to read', () => {
    const html = results([
      { repo: a, kind: 'none' },
      { repo: b, kind: 'unreadable' },
    ]);
    expect(html).toContain('No matches for “retry”.');
    expect(html).not.toContain('Couldn’t search');
  });

  it('notes the cap only once the search has finished', () => {
    const note = `Searched your ${REPO_CAP} most recent repositories`;
    const none: Outcome = { repo: a, kind: 'none' };
    expect(results([none], { capped: true })).not.toContain(note);
    expect(results([none, { repo: b, kind: 'none' }], { capped: true })).toContain(note);
    expect(results([none, { repo: b, kind: 'none' }])).not.toContain(note);
  });

  it('shows one repository without its group heading', () => {
    const one = { within: a, targets: [a] };
    const html = results([{ repo: a, kind: 'found', answer }], one);
    expect(html).toContain(`href="/source/${a}/files/src/a.rs?line=12"`);
    expect(html).not.toContain('search-repo-name');
  });

  it('shows one repository’s failure with a retry, and an unreadable one plainly', () => {
    const one = { within: a, targets: [a] };
    const failed = results(
      [{ repo: a, kind: 'failed', error: 'Something went wrong on our side.' }],
      one,
    );
    expect(failed).toContain('role="alert"');
    expect(failed).toContain('Retry');
    expect(results([{ repo: a, kind: 'unreadable' }], one)).toContain(
      'This repository has nothing to search yet, or you cannot read it.',
    );
  });

  it('shows the same search states while one repository loads', () => {
    expect(results([], { within: a, targets: [a] })).toContain('Loading results');
  });
});
