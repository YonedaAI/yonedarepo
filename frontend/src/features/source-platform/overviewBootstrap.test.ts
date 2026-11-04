import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import {
  advanceOverviewViewer,
  namedOverviewRef,
  type OverviewData,
  type OverviewHandoff,
  type OverviewStatus,
  overviewActivityPath,
  overviewForNavigation,
} from './overviewBootstrap';
import type { SourceRoute } from './sourceRoute';

vi.mock('./connect', async (original) => ({
  ...(await original<typeof import('./connect')>()),
  currentApiOrigin: () => 'https://yoneda.test',
}));

import { resolvePath } from './RepoByName';
import { RepoOverview } from './RepoOverview';
import type { RepoStatus } from './repoStatus';
import { useSource } from './useSource';

const commit = 'a'.repeat(40);
const summary = {
  name: 'demo',
  refs: [{ name: 'refs/heads/main', commit_id: commit, version: 1 }],
  visibility: 'private',
  policy: { approvals: 0, required_checks: [] },
  viewer: { principal: 'user:demo', owner: true, public: false, role: null },
} as unknown as RepoStatus;
const overview: OverviewData = {
  ref: 'main',
  empty: false,
  tree: { commit, path: '', entries: [{ name: 'README.md', type: 'blob', id: 'b'.repeat(40) }] },
  latest: {
    commit,
    message: 'Fresh overview message',
    principal: 'user:demo',
    author_name: 'Demo author',
    authored_at: Date.now(),
    landings: [],
    checks: [],
  },
  readme: {
    commit,
    path: 'README.md',
    encoding: 'utf-8',
    content: 'A rendered overview body.',
    size: 25,
    executable: false,
  },
  activity: {
    commits: [
      {
        commit,
        principal: 'user:demo',
        author_name: 'Demo author',
        authored_at: Date.now(),
      },
    ],
  },
};

describe('overview bootstrap', () => {
  it('keeps initial discovery in the same admission and separates later account changes', () => {
    const initial = { generation: 0 };
    expect(advanceOverviewViewer(initial, 'pending', false)).toBe(initial);
    const admitted = advanceOverviewViewer(initial, 'user:demo', true);
    expect(admitted.generation).toBe(0);
    expect(advanceOverviewViewer(admitted, 'user:demo', true)).toBe(admitted);
    const signedOut = advanceOverviewViewer(admitted, 'anonymous', true);
    expect(signedOut.generation).toBe(1);
    expect(advanceOverviewViewer(signedOut, 'user:demo', true).generation).toBe(2);
  });
  it('opts named Overview into the combined response without changing ordinary resolution', () => {
    expect(resolvePath('demo', 'repo name', 'main')).toBe(
      '/resolve/demo/repo%20name?summary=true&overview=true&ref=main',
    );
    expect(resolvePath('demo', 'repo name')).toBe('/resolve/demo/repo%20name');
  });

  it('accepts the handoff only for its exact navigation, viewer, refresh and ref', () => {
    const route: SourceRoute = { view: 'overview', repo: 'r0123456789abcdef0123', ref: 'main' };
    const status = { ...summary, overview } as OverviewStatus;
    const handoff: OverviewHandoff = {
      route,
      viewer: 'user:demo',
      tick: 0,
      overview: { repo: route.repo, status },
    };
    expect(overviewForNavigation(handoff, route, 'user:demo', 0)).toBe(status);
    expect(overviewForNavigation(handoff, route, 'user:demo', 0, 'user:demo')).toBe(status);
    expect(overviewForNavigation(handoff, route, 'user:demo', 0, 'user:other')).toBeUndefined();
    expect(overviewForNavigation(handoff, route, 'user:demo', 0, 'anonymous')).toBeUndefined();
    expect(
      overviewForNavigation(
        {
          ...handoff,
          overview: {
            ...handoff.overview,
            status: { ...status, viewer: { ...status.viewer, public: true } },
          },
        },
        route,
        'user:demo',
        0,
        'anonymous',
      ),
    ).toBeDefined();
    expect(overviewForNavigation(handoff, { ...route }, 'user:demo', 0)).toBeUndefined();
    expect(overviewForNavigation(handoff, route, 'user:other', 0)).toBeUndefined();
    expect(overviewForNavigation(handoff, route, 'user:demo', 1)).toBeUndefined();
    expect(
      overviewForNavigation(
        { ...handoff, overview: { ...handoff.overview, repo: 'rffffffffffffffffffff' } },
        route,
        'user:demo',
        0,
      ),
    ).toBeUndefined();
    route.ref = 'topic';
    expect(overviewForNavigation(handoff, route, 'user:demo', 0)).toBeUndefined();
  });

  it('keeps old file/version routes on ordinary resolution', () => {
    const route = { view: 'repo-name' as const, owner: 'demo', name: 'repo', rest: '', search: '' };
    expect(namedOverviewRef(route)).toBe('main');
    expect(namedOverviewRef({ ...route, rest: 'overview', search: '?ref=topic' })).toBe('topic');
    expect(namedOverviewRef({ ...route, search: '?ref=topic' })).toBeUndefined();
    expect(namedOverviewRef({ ...route, rest: 'files' })).toBeUndefined();
    expect(namedOverviewRef({ ...route, rest: 'overview', search: '?at=1' })).toBeUndefined();
  });

  it('uses an explicitly fresh initial response on its first render', () => {
    function Probe() {
      const found = useSource('/fresh', undefined, { value: 'admitted' });
      return createElement(
        'p',
        { 'data-current': found.current === true },
        found.data?.value ?? 'pending',
      );
    }
    const html = renderToStaticMarkup(createElement(Probe));
    expect(html).toContain('admitted');
    expect(html).toContain('data-current="true"');
  });

  it('preserves the empty repository view without another directory read', () => {
    const html = renderToStaticMarkup(
      createElement(RepoOverview, {
        repo: 'r0123456789abcdef0123',
        refName: 'main',
        status: { ...summary, refs: [] },
        facts: createElement('span', null, 'facts'),
        navigate: () => {},
        bootstrap: {
          ref: 'main',
          empty: true,
          tree: null,
          latest: null,
          readme: null,
          activity: null,
        },
        onRetry: () => {},
      }),
    );
    expect(html).toContain('main has no commits yet');
    expect(html).toContain('Push a first commit');
    expect(html).not.toContain('Loading files');
  });

  it('keeps successful sections visible when another section fails', () => {
    const failed = {
      ...overview,
      activity: null,
      readme: null,
      errors: {
        activity: { code: 'UNAVAILABLE', message: 'Activity unavailable' },
        readme: { code: 'UNAVAILABLE', message: 'README unavailable' },
      },
    };
    const html = renderToStaticMarkup(
      createElement(RepoOverview, {
        repo: 'r0123456789abcdef0123',
        refName: 'main',
        status: summary,
        facts: createElement('span', null, 'facts'),
        navigate: () => {},
        bootstrap: failed,
        onRetry: () => {},
      }),
    );
    expect(html).toContain('Fresh overview message');
    expect(html).toContain('Activity unavailable');
    expect(html).toContain('README unavailable');
  });

  it('renders bundled content immediately with activity above README', () => {
    const html = renderToStaticMarkup(
      createElement(RepoOverview, {
        repo: 'r0123456789abcdef0123',
        refName: 'main',
        status: summary,
        facts: createElement('span', null, 'facts'),
        navigate: () => {},
        bootstrap: overview,
        onRetry: () => {},
      }),
    );
    expect(html).toContain('Fresh overview message');
    expect(html).toContain('A rendered overview body.');
    expect(html).toContain('Demo author');
    expect(html.indexOf('overview-numbers')).toBeLessThan(
      html.indexOf('class="source-file readme"'),
    );
    expect(html).not.toContain('Loading the latest commit');
    expect(html).not.toContain('Loading README');
  });
});

it('anchors deferred activity to the captured commit and version rather than moving main', () => {
  const path = overviewActivityPath('r0123456789abcdef0123', 'main', {
    ref: 'topic/name',
    from: commit,
    at: 7,
  });
  const url = new URL(path, 'https://example.test');
  expect(url.searchParams.get('ref')).toBe('topic/name');
  expect(url.searchParams.get('from')).toBe(commit);
  expect(url.searchParams.get('at')).toBe('7');
  expect(url.searchParams.get('limit')).toBe('200');
  expect(url.searchParams.get('view')).toBe('overview');
  expect(overviewActivityPath('r0123456789abcdef0123', 'main')).toBe(
    '/repos/r0123456789abcdef0123/log?ref=main&limit=200',
  );
});
