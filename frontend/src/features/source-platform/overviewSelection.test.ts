import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it, vi } from 'vitest';

const captured = vi.hoisted(() => ({ listing: [] as (string | undefined)[] }));
vi.mock('./connect', async (original) => ({
  ...(await original<typeof import('./connect')>()),
  currentApiOrigin: () => 'https://yoneda.test',
}));
vi.mock('./codeData', async (original) => ({
  ...(await original<typeof import('./codeData')>()),
  useListing: (_repo: string, ref: string | undefined) => {
    captured.listing.push(ref);
    return { reload: () => {} };
  },
}));
vi.mock('./useSource', () => ({
  useSource: () => ({
    loading: false,
    reload: () => {},
    data: {
      name: 'demo',
      refs: [
        { name: 'refs/heads/main', commit_id: 'a'.repeat(40) },
        { name: 'refs/heads/topic', commit_id: 'c'.repeat(40) },
      ],
      visibility: 'private',
      viewer: { owner: true, public: false, principal: 'user:demo' },
      policy: { required_checks: [], approvals: 0 },
      overview: {
        ref: 'main',
        tree: { commit: 'a'.repeat(40), entries: [] },
        readme: { content: 'Old README' },
        activity: null,
        latest: null,
        empty: false,
      },
    },
  }),
}));
const { RepoPage } = await import('./RepoPage');
it('suppresses the previous ref before the next request loading effect runs', () => {
  captured.listing.length = 0;
  const html = renderToStaticMarkup(
    createElement(RepoPage, {
      route: { view: 'overview', repo: 'r0123456789abcdef0123', ref: 'topic' },
      authenticated: true,
      username: 'demo',
      navigate: () => {},
      onDeleted: () => {},
      onMissing: () => {},
    }),
  );
  expect(captured.listing).toEqual([undefined]);
  expect(html).not.toContain('Old README');
});
