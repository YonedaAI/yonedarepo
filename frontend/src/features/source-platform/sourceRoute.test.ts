import { describe, expect, it } from 'vitest';
import { patchRows } from './patchRows';
import {
  formatSourceRoute,
  parseSourceRoute,
  routeTab,
  type SourceRoute,
  tabRoute,
} from './sourceRoute';

const repo = `r${'a'.repeat(20)}`;
const sha = 'b'.repeat(40);

describe('source routes', () => {
  it('round-trips every view', () => {
    const routes: SourceRoute[] = [
      { view: 'home' },
      { view: 'explore' },
      { view: 'settings' },
      { view: 'files', repo, path: '', ref: 'main' },
      { view: 'files', repo, path: 'src/a b.rs', ref: 'feature/x', at: 3 },
      { view: 'history', repo, ref: 'main' },
      { view: 'history', repo, ref: 'dev' },
      { view: 'commit', repo, commit: sha },
      { view: 'transactions', repo },
      { view: 'search', repo, query: 'retry with' },
      { view: 'search', repo, query: 'test', word: true },
      { view: 'overview', repo, path: '', ref: 'main' },
      { view: 'overview', repo, path: 'src/net', ref: 'dev', at: 4 },
      { view: 'changes', repo },
      { view: 'change', repo, number: 12 },
      { view: 'releases', repo },
      { view: 'release', repo, tag: 'v1.2.0' },
      { view: 'release', repo, tag: 'team/v 2' },
      { view: 'repo-settings', repo, section: 'rules' },
      { view: 'repo-settings', repo, section: 'webhooks' },
      { view: 'repo-settings', repo, section: 'visibility' },
      { view: 'repositories' },
      { view: 'context', repo },
    ];
    for (const route of routes) {
      const url = new URL(formatSourceRoute(route), 'https://x');
      expect(parseSourceRoute(url.pathname, url.search)).toEqual(route);
    }
  });
  it('lists public repositories at /source/explore, also reached from the bare /explore', () => {
    expect(formatSourceRoute({ view: 'explore' })).toBe('/source/explore');
    expect(parseSourceRoute('/source/explore', '')).toEqual({ view: 'explore' });
    expect(parseSourceRoute('/explore', '')).toEqual({ view: 'explore' });
    expect(parseSourceRoute('/explore/', '')).toEqual({ view: 'explore' });
    // Not a repository id, and nothing nests under it.
    expect(parseSourceRoute('/source/explore/x', '')).toEqual({ view: 'home' });
    expect(routeTab({ view: 'explore' })).toBeUndefined();
  });
  it('falls back safely on malformed input', () => {
    expect(parseSourceRoute('/source/not-a-repo', '')).toEqual({ view: 'home' });
    expect(parseSourceRoute('/source', '')).toEqual({ view: 'home' });
    expect(parseSourceRoute(`/source/${repo}/settings/nope`, '')).toEqual({
      view: 'repo-settings',
      repo,
      section: 'rules',
    });
    expect(parseSourceRoute(`/source/${repo}/commit/xyz`, '')).toMatchObject({ view: 'files' });
    for (const bad of ['0', '-1', '1.5', '07', 'x', '99999999999999999999'])
      expect(parseSourceRoute(`/source/${repo}/changes/${bad}`, '')).toEqual({
        view: 'changes',
        repo,
      });
    expect(parseSourceRoute(`/source/${repo}`, '?at=-1')).toEqual({
      view: 'files',
      repo,
      path: '',
      ref: 'main',
    });
  });
});

describe('repository pages', () => {
  it('groups views under their sidebar page and starts each page at its first view', () => {
    expect(routeTab({ view: 'files', repo, path: 'src', ref: 'main' })).toBe('overview');
    expect(routeTab({ view: 'overview', repo, path: '', ref: 'main' })).toBe('overview');
    expect(routeTab({ view: 'transactions', repo })).toBe('commits');
    expect(routeTab({ view: 'commit', repo, commit: sha })).toBe('commits');
    expect(routeTab({ view: 'repo-settings', repo, section: 'tokens' })).toBe('settings');
    expect(routeTab({ view: 'change', repo, number: 3 })).toBe('changes');
    expect(routeTab({ view: 'context', repo })).toBe('context');
    expect(routeTab({ view: 'settings' })).toBeUndefined();
    expect(routeTab({ view: 'repositories' })).toBeUndefined();
    for (const tab of [
      'overview',
      'changes',
      'agents',
      'commits',
      'sessions',
      'context',
      'releases',
      'search',
      'settings',
    ] as const)
      expect(routeTab(tabRoute(tab, repo))).toBe(tab);
    // The old deep links keep their addresses.
    expect(formatSourceRoute(tabRoute('overview', repo))).toBe(`/source/${repo}`);
    expect(formatSourceRoute(tabRoute('commits', repo))).toBe(`/source/${repo}/history`);
    expect(formatSourceRoute(tabRoute('sessions', repo))).toBe(`/source/${repo}/agents`);
    expect(formatSourceRoute(tabRoute('agents', repo))).toBe(`/source/${repo}/agents/contracts`);
  });
  it('addresses the repository list and the agent context page', () => {
    expect(formatSourceRoute({ view: 'repositories' })).toBe('/repositories');
    expect(parseSourceRoute('/repositories', '')).toEqual({ view: 'repositories' });
    expect(parseSourceRoute('/repositories/x', '')).toEqual({ view: 'home' });
    expect(formatSourceRoute({ view: 'context', repo })).toBe(`/source/${repo}/context`);
  });
});

describe('patch rows', () => {
  it('numbers old and new lines across hunks', () => {
    const rows = patchRows(
      '@@ -1,2 +1,2 @@\n a\n-b\n+B\n@@ -9 +9,2 @@\n x\n+y\n\\ No newline at end of file\n',
    );
    expect(rows).toEqual([
      { kind: 'hunk', text: '@@ -1,2 +1,2 @@' },
      { kind: 'context', text: 'a', old: 1, new: 1 },
      { kind: 'delete', text: 'b', old: 2 },
      { kind: 'add', text: 'B', new: 2 },
      { kind: 'hunk', text: '@@ -9 +9,2 @@' },
      { kind: 'context', text: 'x', old: 9, new: 9 },
      { kind: 'add', text: 'y', new: 10 },
      { kind: 'note', text: 'No newline at end of file' },
    ]);
  });
});
