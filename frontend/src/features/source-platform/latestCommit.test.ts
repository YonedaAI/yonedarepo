import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it, vi } from 'vitest';

const calls = vi.hoisted(() => [] as (string | null)[]);
vi.mock('./useSource', () => ({
  useSource: (path: string | null) => {
    calls.push(path);
    return { loading: true };
  },
}));

import { LatestCommit } from './CodeParts';

it('leaves an unpublished commit row stable without reading or linking a null commit', () => {
  calls.length = 0;
  const link = vi.fn((id, children) => createElement('a', { href: `/commit/${id}` }, children));
  const page = renderToStaticMarkup(
    createElement(LatestCommit, { repo: 'fixture', commit: null, commitLink: link }),
  );
  expect(page).toContain('aria-busy="true"');
  expect(page).toContain('Loading the latest commit');
  expect(calls).toEqual([null]);
  expect(link).not.toHaveBeenCalled();
});
it('still reads and links a known commit while its detail is loading', () => {
  calls.length = 0;
  const commit = 'a'.repeat(40);
  const page = renderToStaticMarkup(
    createElement(LatestCommit, {
      repo: 'fixture',
      commit,
      commitLink: (id, children) => createElement('a', { href: `/commit/${id}` }, children),
    }),
  );
  expect(calls).toEqual([`/repos/fixture/commits/${commit}`]);
  expect(page).toContain(`href="/commit/${commit}"`);
});
