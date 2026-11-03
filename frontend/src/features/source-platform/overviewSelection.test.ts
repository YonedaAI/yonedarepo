import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, expect, it, vi } from 'vitest';
import type { OverviewStatus } from './overviewBootstrap';

const captured = vi.hoisted(() => ({
  listing: [] as (string | undefined)[],
  paths: [] as (string | null)[],
  response: {} as {
    current?: boolean;
    loading?: boolean;
    data?: unknown;
    error?: string;
    code?: string;
    errorStatus?: number;
  },
}));
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
  useSource: (path: string | null) => {
    captured.paths.push(path);
    return {
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
          activity: null,
          latest: { commit: 'a'.repeat(40), message: 'Old latest', landings: [], checks: [] },
          readme: { content: 'Old README', encoding: 'utf-8' },
          empty: false,
        },
      },
      ...captured.response,
    };
  },
}));
const { RepoPage } = await import('./RepoPage');
beforeEach(() => {
  captured.response = {};
  captured.listing.length = 0;
  captured.paths.length = 0;
});
it('suppresses the previous ref before the next request loading effect runs', () => {
  captured.listing.length = 0;
  const html = renderToStaticMarkup(
    createElement(RepoPage, {
      route: { view: 'overview', repo: 'r0123456789abcdef0123', ref: 'topic' },
      initialStatus: { overview: { ref: 'main' } } as OverviewStatus,
      authenticated: true,
      username: 'demo',
      navigate: () => {},
      onDeleted: () => {},
      onMissing: () => {},
    }),
  );
  expect(captured.listing).toEqual([undefined]);
  expect(html).not.toContain('Old README');
  expect(html).toContain('Couldn&#x27;t load the selected branch.');
  expect(html).toContain('Retry');
});

function statusPath(initialStatus?: OverviewStatus) {
  captured.paths.length = 0;
  renderToStaticMarkup(
    createElement(RepoPage, {
      route: { view: 'overview', repo: 'r0123456789abcdef0123', ref: 'topic' },
      initialStatus,
      authenticated: true,
      username: 'demo',
      navigate: () => {},
      onDeleted: () => {},
      onMissing: () => {},
    }),
  );
  return captured.paths[0];
}
it('opts an unseeded picker or ID mount into the existing bundled response', () => {
  expect(statusPath()).toBe('/repos/r0123456789abcdef0123?summary=true&overview=true&ref=topic');
});
it('keeps a named bootstrap mount opted in for selected branch refreshes', () => {
  expect(statusPath({ overview: { ref: 'main' } } as OverviewStatus)).toBe(
    '/repos/r0123456789abcdef0123?summary=true&overview=true&ref=topic',
  );
});

const plain = {
  name: 'demo',
  refs: [{ name: 'refs/heads/main', commit_id: 'a'.repeat(40) }],
  visibility: 'private',
  viewer: { owner: true, public: false, principal: 'user:demo' },
  policy: { required_checks: [], approvals: 0 },
};
function main() {
  return renderToStaticMarkup(
    createElement(RepoPage, {
      route: { view: 'overview', repo: 'r0123456789abcdef0123', ref: 'main' },
      authenticated: true,
      username: 'demo',
      navigate: () => {},
      onDeleted: () => {},
      onMissing: () => {},
    }),
  );
}
it('does not start legacy reads from retained Files metadata before the next effect runs', () => {
  captured.response = { data: plain, current: false, loading: false };
  main();
  expect(captured.listing).toEqual([undefined]);
});
it('uses legacy fallback only after the current OFF or old-server response settles', () => {
  captured.response = { data: plain, current: true, loading: false };
  main();
  expect(captured.listing).toEqual(['main']);
});
it('does not reuse the preceding same-ref bundle during a refresh', () => {
  captured.response = { current: false, loading: false };
  const html = main();
  expect(captured.listing).toEqual([undefined]);
  expect(html).not.toContain('Old README');
});
it('never selects a legacy read after a current denial or error', () => {
  for (const code of ['NOT_FOUND', 'FORBIDDEN', 'UNAVAILABLE']) {
    captured.listing.length = 0;
    captured.response = {
      data: undefined,
      current: true,
      loading: false,
      error: 'Denied',
      code,
      errorStatus: code === 'UNAVAILABLE' ? 503 : 404,
    };
    main();
    expect(captured.listing).toEqual([]);
  }
});
it('retains the non-Overview error view when no current metadata exists', () => {
  captured.response = {
    data: undefined,
    current: true,
    loading: false,
    error: 'Failed',
    code: 'UNAVAILABLE',
    errorStatus: 503,
  };
  const html = renderToStaticMarkup(
    createElement(RepoPage, {
      route: { view: 'files', repo: 'r0123456789abcdef0123', ref: 'main', path: '' },
      authenticated: true,
      username: 'demo',
      navigate: () => {},
      onDeleted: () => {},
      onMissing: () => {},
    }),
  );
  expect(html).toContain('Failed');
  expect(captured.listing).toEqual([]);
});
