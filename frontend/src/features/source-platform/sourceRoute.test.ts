import { describe, expect, it } from 'vitest';
import type { AccountSection } from '../account-settings/settingsRoute';
import { agentsReturnPath, RETURN_PATH } from '../agents/billingModel';
import { patchRows } from './patchRows';
import { forgetRepoNames, rememberRepoName, repoBase } from './repoNames';
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
      { view: 'settings', section: 'general' },
      { view: 'settings', section: 'billing' },
      { view: 'settings', section: 'billing', cardAdded: true },
      { view: 'settings', section: 'tokens' },
      { view: 'settings', section: 'ssh-keys' },
      { view: 'settings', section: 'organizations' },
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
  it('gives each account settings page its own address', () => {
    const settings = (section: AccountSection) => ({ view: 'settings', section }) as const;
    expect(formatSourceRoute(settings('general'))).toBe('/settings');
    expect(formatSourceRoute(settings('billing'))).toBe('/settings/billing');
    expect(formatSourceRoute(settings('tokens'))).toBe('/settings/tokens');
    expect(formatSourceRoute(settings('ssh-keys'))).toBe('/settings/ssh-keys');
    expect(formatSourceRoute(settings('organizations'))).toBe('/settings/organizations');
    expect(parseSourceRoute('/settings/billing/', '')).toEqual(settings('billing'));
    // Nothing else nests under it, and `general` has the bare address.
    expect(parseSourceRoute('/settings/nope', '')).toEqual(settings('general'));
    expect(parseSourceRoute('/settings/billing/x', '')).toEqual(settings('general'));
    expect(parseSourceRoute('/settings/general', '')).toEqual(settings('general'));
  });
  it('sends the old single page anchors to the page that holds them', () => {
    const at = (hash: string) => parseSourceRoute('/settings', '', hash);
    expect(at('#billing')).toEqual({ view: 'settings', section: 'billing' });
    expect(at('#personal-tokens')).toEqual({ view: 'settings', section: 'tokens' });
    expect(at('#ssh-keys')).toEqual({ view: 'settings', section: 'ssh-keys' });
    expect(at('#organizations')).toEqual({ view: 'settings', section: 'organizations' });
    expect(at('#account')).toEqual({ view: 'settings', section: 'general' });
    expect(at('#nope')).toEqual({ view: 'settings', section: 'general' });
    // An anchor means nothing elsewhere.
    expect(parseSourceRoute('/settings/tokens', '', '#billing')).toEqual({
      view: 'settings',
      section: 'tokens',
    });
    expect(parseSourceRoute('/repositories', '', '#billing')).toEqual({ view: 'repositories' });
  });
  it('keeps the Stripe return flag, old or new, so the page can wait for the card', () => {
    const added = { view: 'settings', section: 'billing', cardAdded: true };
    expect(parseSourceRoute('/settings', '?billing=added')).toEqual(added);
    expect(parseSourceRoute('/settings/billing', '?billing=added')).toEqual(added);
    expect(formatSourceRoute(parseSourceRoute('/settings', '?billing=added'))).toBe(RETURN_PATH);
    // Only Billing takes it, and only with that value.
    expect(parseSourceRoute('/settings/tokens', '?billing=added')).toEqual({
      view: 'settings',
      section: 'tokens',
    });
    expect(parseSourceRoute('/settings', '?billing=other')).toEqual({
      view: 'settings',
      section: 'general',
    });
  });
  it("keeps the Stripe return flag on the Agents page, an org's too", () => {
    const at = (search: string) => parseSourceRoute('/agents', search);
    expect(at('?billing=added')).toEqual({ view: 'agents-home', cardAdded: true });
    expect(at('?workspace=acme&billing=added')).toEqual({
      view: 'agents-home',
      workspace: 'acme',
      cardAdded: true,
    });
    // The shell rewrites to this address: what Stripe was given must survive it.
    for (const path of [agentsReturnPath(), agentsReturnPath('acme')]) {
      const url = new URL(path, 'https://x');
      expect(formatSourceRoute(parseSourceRoute(url.pathname, url.search))).toBe(path);
    }
    expect(formatSourceRoute(at('?billing=added&workspace=acme'))).toBe(agentsReturnPath('acme'));
    // Only the Agents page takes it, and only with that value.
    expect(at('?billing=other')).toEqual({ view: 'agents-home' });
    expect(parseSourceRoute('/agents/runs', '?billing=added')).toEqual({ view: 'agent-runs' });
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
    expect(routeTab({ view: 'settings', section: 'general' })).toBeUndefined();
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

describe('readable addresses', () => {
  const parse = (url: string) => {
    const [path, query = ''] = url.split('?');
    return parseSourceRoute(path, query ? `?${query}` : '');
  };

  it('parses a profile and a repository by handle and name, and formats them back', () => {
    expect(parse('/ada')).toEqual({ view: 'profile', handle: 'ada' });
    expect(parse('/ada?tab=repositories')).toEqual({
      view: 'profile',
      handle: 'ada',
      tab: 'repositories',
    });
    const named = parse('/ada/retry-kit/history?ref=fix');
    expect(named).toEqual({
      view: 'repo-name',
      owner: 'ada',
      name: 'retry-kit',
      rest: 'history',
      search: '?ref=fix',
    });
    for (const url of ['/ada', '/ada?tab=repositories', '/ada/retry-kit/history?ref=fix'])
      expect(formatSourceRoute(parse(url))).toBe(url);
  });

  it('keeps the app’s own paths and refuses what no handle or name can be', () => {
    expect(parse('/orgs/Acme')).toEqual({ view: 'home' });
    expect(parse('/repositories/x')).toEqual({ view: 'home' });
    expect(parse('/Ada')).toEqual({ view: 'home' });
    expect(parse('/ada/.hidden')).toEqual({ view: 'home' });
    expect(parse('/ada@example.com')).toEqual({ view: 'home' });
  });

  it('formats a repository under its readable base once known; /source/<id> still parses', () => {
    forgetRepoNames();
    const files: SourceRoute = { view: 'files', repo, path: 'src/a.ts', ref: 'main' };
    expect(formatSourceRoute(files)).toBe(`/source/${repo}/files/src/a.ts`);
    rememberRepoName(repo, 'ada@example.com', 'retry-kit');
    expect(formatSourceRoute(files)).toBe(`/source/${repo}/files/src/a.ts`);
    rememberRepoName(repo, 'ada', 'retry-kit');
    expect(repoBase(repo)).toBe('/ada/retry-kit');
    expect(formatSourceRoute(files)).toBe('/ada/retry-kit/files/src/a.ts');
    expect(formatSourceRoute({ view: 'change', repo, number: 12 })).toBe(
      '/ada/retry-kit/changes/12',
    );
    expect(parse(`/source/${repo}/files/src/a.ts`)).toEqual(files);
    forgetRepoNames();
  });
});
