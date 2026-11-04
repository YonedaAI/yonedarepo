import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it, vi } from 'vitest';
import { AdminRepos } from './AdminLists';
import { repositoryListPath } from './AdminRepositories';

vi.mock('../source-platform/useSource', () => ({
  useSource: () => ({
    data: {
      items: [
        {
          id: 'r00000000000000000001',
          name: 'sample',
          owner: 'owner',
          handle: 'shown',
          visibility: 'public',
          created_at: 1000,
          db_bytes: null,
          level: null,
        },
      ],
      next: null,
    },
    loading: false,
    reload() {},
  }),
}));
vi.mock('./AdminRepoUsage', () => ({
  RepoUsage: () =>
    createElement('section', { 'aria-label': 'Repository use' }, 'Use, last 30 days'),
}));
it('shows one searchable repository table with accessible server sort controls and unknown sampled storage', () => {
  const html = renderToStaticMarkup(createElement(AdminRepos, { navigate: () => {} }));
  expect(html.match(/<table /g)).toHaveLength(1);
  expect(html).not.toContain('Largest repositories');
  expect(html).toContain('Search names and owners');
  expect(html).toContain('aria-sort="descending"');
  expect(html).toContain('Database');
  expect(html).toContain('Unknown');
  expect(html).toContain('Details');
  expect(html).toContain('Sort by owner');
});

it('encodes the server order and opaque cursor with search rather than sorting loaded rows', () => {
  const path = repositoryListPath(
    ' displayed ',
    { sort: 'owner', direction: 'asc' },
    '{"id":"cursor"}',
  );
  const query = new URL(path, 'https://local').searchParams;
  expect(query.get('sort')).toBe('owner');
  expect(query.get('direction')).toBe('asc');
  expect(query.get('q')).toBe('displayed');
  expect(query.get('cursor')).toBe('{"id":"cursor"}');
});

it('keeps Admin Repositories focused on the searchable listing without requesting usage', () => {
  const html = renderToStaticMarkup(createElement(AdminRepos, { navigate: () => {} }));
  expect(html).not.toContain('Use, last');
  expect(html).not.toContain('Repository use');
  expect(html).toContain('Search names and owners');
  expect(html).toContain('Filters');
});

it('carries exact-owner and visibility filters through every continuation request', () => {
  const path = repositoryListPath(' sample ', { sort: 'database', direction: 'desc' }, 'next', {
    owner: ' shown ',
    visibility: 'private',
  });
  const query = new URL(path, 'https://local').searchParams;
  expect(query.get('owner')).toBe('shown');
  expect(query.get('visibility')).toBe('private');
  expect(query.get('q')).toBe('sample');
  expect(query.get('cursor')).toBe('next');
});
