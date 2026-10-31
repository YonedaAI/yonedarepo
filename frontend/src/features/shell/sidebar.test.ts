// The shell's sidebar, icon rail and repository picker: rows named "<name>, <label>" for
// assistive technology, the open repository's pages (Settings only for its admins), the
// Account group on settings pages, Explore signed in or out, and the picker as a combobox
// over a listbox, grouped, with hearts apart from the rows.
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { AccountSection } from '../account-settings/settingsRoute';
import { formatSourceRoute, type SourceRoute } from '../source-platform/sourceRoute';
import { AppRail } from './AppRail';
import { AppSidebar, labelled } from './AppSidebar';
import { RepoPicker } from './RepoPicker';
import type { Favorites } from './useFavorites';

const a = 'r0000000000000000000a';
const b = 'r0000000000000000000b';
const home: SourceRoute = { view: 'home' };
const favorites = (over: Partial<Favorites> = {}): Favorites => ({
  ids: new Set(),
  rows: [],
  error: '',
  loadError: '',
  toggle: () => true,
  reload: () => {},
  ...over,
});
const sidebar = (props: object) =>
  renderToStaticMarkup(
    createElement(AppSidebar, {
      authenticated: true,
      loading: false,
      route: home,
      favorites: favorites(),
      ...props,
    }),
  );

describe('sidebar', () => {
  it('names a row with its label, and leaves an unlabelled row to its text', () => {
    expect(labelled('acme', 'owner')).toBe('acme, owner');
    expect(labelled('mine')).toBeUndefined();
  });

  it('keeps the organization links, and no list of repositories', () => {
    const html = sidebar({
      rows: [{ repo: a, name: 'mine' }],
      orgs: [{ org: 'acme', role: 'owner' }],
    });
    expect(html).toContain('aria-label="acme, owner"');
    // The visible name stays in its own element (the browser gate finds org rows by it).
    expect(html).toContain('<span class="rail-repo-name">acme</span>');
    expect(html).not.toContain('aria-label="Repositories"');
    expect(html).not.toContain('Your repositories');
    expect(html).not.toContain('mine');
    expect(html).toContain('Choose a repository');
    expect(html.indexOf('Choose a repository')).toBeLessThan(html.indexOf('acme'));
  });

  it('orders Browse, Repository, then Organizations, with no group for an account with none', () => {
    const route: SourceRoute = { view: 'changes', repo: a };
    const orgs = [{ org: 'acme', role: 'owner' }];
    const html = sidebar({ route, orgs, rows: [{ repo: a, name: 'parser' }] });
    const at = (label: string) => html.indexOf(`<p class="side-label">${label}</p>`);
    expect(at('Browse')).toBeGreaterThanOrEqual(0);
    expect(at('Repository')).toBeGreaterThan(at('Browse'));
    expect(html.indexOf('aria-label="Repository"')).toBeGreaterThan(at('Repository'));
    expect(at('Organizations')).toBeGreaterThan(html.indexOf('aria-label="Repository"'));
    const none = sidebar({ route, orgs: [], rows: [{ repo: a, name: 'parser' }] });
    expect(none).not.toContain('Organizations');
  });

  it('offers New repository for an account with none, and the picker while they load', () => {
    const onNew = () => {};
    const empty = sidebar({ rows: [], onNew });
    expect(empty).toContain('New repository');
    expect(empty).not.toContain('Choose a repository');
    expect(sidebar({ rows: [], onNew, loading: true })).toContain('Choose a repository');
    const failed = sidebar({ rows: [], onNew, rowsError: 'Something went wrong on our side.' });
    expect(failed).toContain('Choose a repository');
    expect(failed).toContain('source-error');
    expect(failed).not.toContain('New repository');
  });

  it('offers Explore signed in or out, and a signed-out visitor no picker', () => {
    expect(sidebar({})).toContain('href="/source/explore"');
    const out = sidebar({ authenticated: false, route: { view: 'explore' } });
    expect(out).toMatch(/aria-current="page" class="active" href="\/source\/explore"/);
    expect(out).not.toContain('New repository');
    expect(out).not.toContain('Choose a repository');
    // On a public repository: its name and pages, and nothing to pick or favorite.
    const open = sidebar({
      authenticated: false,
      route: { view: 'files', repo: a, path: '', ref: 'main' },
      repoName: 'compiler',
    });
    expect(open).toContain('compiler');
    expect(open).toContain('aria-label="Repository"');
    expect(open).not.toContain('picker-heart');
    expect(open).not.toContain('Switch repository');
  });

  it("lists the open repository's pages, Settings only for its admins", () => {
    const route: SourceRoute = { view: 'agents', repo: a, section: 'sessions' };
    const html = sidebar({ route, rows: [{ repo: a, name: 'parser' }] });
    expect(html).toContain('aria-label="Favorite parser"');
    const pages = [...html.matchAll(/<span class="side-text">([A-Za-z ]+)<\/span>/g)].map(
      (m) => m[1],
    );
    expect(pages).toEqual([
      'Home',
      'Repositories',
      'Explore',
      'Agents',
      'Overview',
      'Changes',
      'Commits',
      'Sessions',
      'Memories',
      'Context',
      'Agent tools',
      'Releases',
      'Search',
    ]);
    expect(html).toContain('aria-label="Repository"');
    expect(html).toMatch(/aria-current="page" class="active" href="\/source\/r0+a\/agents"/);
    expect(html).toContain('Switch repository (current: parser)');
    expect(sidebar({ route, settings: true })).toContain(`href="/source/${a}/settings"`);
    // Not on a repository: the picker only, with no heart.
    const nowhere = sidebar({ rows: [{ repo: a, name: 'parser' }] });
    expect(nowhere).toContain('Choose a repository');
    expect(nowhere).not.toContain('aria-label="Repository"');
    expect(nowhere).not.toContain('picker-heart');
  });
});

describe('the Account group', () => {
  const group = (section: AccountSection) => {
    const html = sidebar({ route: { view: 'settings', section } });
    const start = html.indexOf('<nav class="side-nav" aria-label="Account"');
    return start < 0 ? '' : html.slice(start, html.indexOf('</nav>', start));
  };

  it('lists the settings pages on any settings page, the open one current', () => {
    const nav = group('billing');
    expect([...nav.matchAll(/href="([^"]+)"/g)].map((m) => m[1])).toEqual([
      '/settings',
      '/settings/billing',
      '/settings/tokens',
      '/settings/ssh-keys',
      '/settings/organizations',
    ]);
    expect([...nav.matchAll(/<span class="side-text">([^<]+)</g)].map((m) => m[1])).toEqual([
      'General',
      'Billing',
      'Tokens',
      'SSH keys',
      'Organizations',
    ]);
    expect(nav).toContain('<p class="side-label">Account</p>');
    expect(nav.match(/aria-current="page"/g)).toHaveLength(1);
    expect(nav).toMatch(/aria-current="page" class="active" href="\/settings\/billing"/);
    expect(group('general')).toMatch(/aria-current="page" class="active" href="\/settings"/);
  });

  it('leaves only Browse and Account on a settings page: no picker until it is asked for', () => {
    const html = sidebar({
      route: { view: 'settings', section: 'general' },
      rows: [{ repo: a, name: 'parser' }],
      orgs: [{ org: 'acme', role: 'owner' }],
    });
    expect(html).not.toContain('aria-label="Organizations"');
    expect(html).not.toContain('acme');
    expect(html).toContain('aria-label="Account"');
    expect(html).toContain('aria-label="Browse"');
    expect(html).not.toContain('aria-label="Repositories"');
    expect(html).not.toContain('Your repositories');
    expect(html).not.toContain('Choose a repository');
    expect(html).not.toContain('parser');
    const asked = sidebar({
      route: { view: 'settings', section: 'general' },
      rows: [{ repo: a, name: 'parser' }],
      orgs: [{ org: 'acme', role: 'owner' }],
      picking: true,
    });
    expect(asked).toContain('role="combobox"');
    expect(asked).not.toContain('aria-label="Organizations"');
    expect(asked).toContain('aria-label="Account"');
    expect(asked).not.toContain('aria-label="Repository"');
  });

  it('stays out of other pages, and of a signed-out visitor', () => {
    expect(sidebar({})).not.toContain('aria-label="Account"');
    expect(
      sidebar({ authenticated: false, route: { view: 'settings', section: 'general' } }),
    ).not.toContain('aria-label="Account"');
  });
});

describe('the highlighted page', () => {
  // Every repository route highlights exactly one Repository entry: the page it is on.
  const active = (route: SourceRoute) => {
    const html = sidebar({ route, settings: true });
    const nav = html.slice(html.indexOf('aria-label="Repository"'));
    return [
      ...nav.matchAll(
        /aria-current="page"[^>]*>(?:<svg.*?<\/svg>)?<span class="side-text">([^<]+)</g,
      ),
    ].map((m) => m[1]);
  };
  for (const [route, page] of [
    [{ view: 'files', repo: a, path: '', ref: 'main' }, 'Overview'],
    [{ view: 'changes', repo: a }, 'Changes'],
    [{ view: 'change', repo: a, number: 2 }, 'Changes'],
    [{ view: 'history', repo: a, ref: 'main' }, 'Commits'],
    [{ view: 'agents', repo: a, section: 'sessions' }, 'Sessions'],
    [{ view: 'session', repo: a, id: 3 }, 'Sessions'],
    [{ view: 'agents', repo: a, section: 'memories' }, 'Memories'],
    [{ view: 'context', repo: a }, 'Context'],
    [{ view: 'agents', repo: a, section: 'contracts' }, 'Agent tools'],
    [{ view: 'agents', repo: a, section: 'pins' }, 'Agent tools'],
    [{ view: 'agents', repo: a, section: 'bisects' }, 'Agent tools'],
    [{ view: 'releases', repo: a }, 'Releases'],
    [{ view: 'search', repo: a, query: '' }, 'Search'],
    [{ view: 'repo-settings', repo: a, section: 'rules' }, 'Settings'],
  ] as [SourceRoute, string][])
    it(`is ${page} on ${formatSourceRoute(route)}`, () => {
      expect(active(route)).toEqual([page]);
    });
});

describe('the workspace Agents entry', () => {
  it('holds every Agents page in Browse, keeping the workspace, and is signed-in only', () => {
    const browse = (route: SourceRoute, authenticated = true) =>
      sidebar({ route, authenticated }).split('class="side-section"')[0];
    for (const route of [
      { view: 'agents-home' },
      { view: 'agent-settings', agent: 'code-review' },
      { view: 'agent-runs', agent: 'slop-review' },
      { view: 'agent-run', runRepo: a, run: `${a}-cr-1-aaaaaaaaaaaa` },
    ] as SourceRoute[])
      expect(browse(route)).toMatch(/aria-current="page" class="active" href="\/agents"/);
    expect(browse({ view: 'agents-home', workspace: 'acme' })).toContain(
      'href="/agents?workspace=acme"',
    );
    expect(browse(home)).toMatch(/href="\/agents"><svg/);
    expect(browse(home, false)).not.toContain('href="/agents"');
  });
});

describe('a repository that is gone', () => {
  // Deleted while open (the next read answered GONE) or reached by a stale link to one of its
  // pages: no Repository pages and no current entry, only the account's repositories.
  for (const route of [
    { view: 'changes', repo: a },
    { view: 'agents', repo: a, section: 'sessions' },
  ] as SourceRoute[])
    it(`hides the Repository pages on ${route.view}`, () => {
      const html = sidebar({
        route,
        missing: true,
        repoName: 'deleted',
        rows: [{ repo: b, name: 'mine' }],
      });
      expect(html).not.toContain('deleted');
      expect(html).not.toContain('aria-label="Repository"');
      expect(html).not.toContain(`href="/source/${a}`);
      expect(html).toContain('Choose a repository');
      expect(html).not.toContain('picker-heart');
      const shortcuts = renderToStaticMarkup(
        createElement(AppRail, {
          authenticated: true,
          route,
          missing: true,
          collapsed: false,
          onToggle: () => {},
          navigate: () => {},
          onNew: () => {},
          onImport: () => {},
        }),
      );
      expect(shortcuts).not.toContain(`href="/source/${a}`);
    });
});

describe('repository picker', () => {
  const rows = [
    { repo: a, name: 'parser' },
    { repo: b, name: 'docs', owner: 'ada', public: true },
  ];
  const picker = (props: object = {}) =>
    renderToStaticMarkup(
      createElement(RepoPicker, {
        rows,
        current: a,
        favorites: favorites(),
        open: true,
        onOpenChange: () => {},
        navigate: () => {},
        onNew: () => {},
        ...props,
      }),
    );

  it('opens on a combobox over a listbox of options, marking the open one', () => {
    const html = picker();
    expect(html).toContain('aria-expanded="true"');
    expect(html).toMatch(/role="combobox"[^>]*aria-label="Find repositories"/);
    expect(html).toMatch(/aria-controls="[^"]+-list"/);
    expect(html).toMatch(/role="listbox"/);
    expect(html).toMatch(/aria-activedescendant="[^"]+"/);
    expect(html.match(/role="option"/g)).toHaveLength(2);
    expect(html).toMatch(/role="option" aria-selected="true"[^>]*href="\/source\/r0+a"/);
    expect(html).toMatch(/role="option" aria-selected="false"[^>]*href="\/source\/r0+b"/);
    expect(html).toContain('ada/docs');
    expect(html).toContain('aria-label="ada/docs, public"');
    expect(html).toContain('>Public</small>');
    expect(html).toContain('title="ada/docs"');
  });

  it('keeps every heart a button of its own, outside its option', () => {
    const html = picker();
    const options = [...html.matchAll(/<a [^>]*role="option".*?<\/a>/g)].map((m) => m[0]);
    expect(options).toHaveLength(2);
    for (const option of options) expect(option).not.toContain('<button');
    expect(html.match(/class="picker-heart/g)).toHaveLength(3);
    // In the list: for the pointer, so the listbox holds only options; the closed row's speaks.
    expect(html.match(/aria-hidden="true" tabindex="-1"/g)).toHaveLength(2);
    expect(html).toContain('aria-label="Favorite parser"');
    expect(html).toContain('aria-pressed="false"');
    expect(picker({ favorites: favorites({ ids: new Set([a]) }) })).toContain(
      'aria-pressed="true"',
    );
  });

  it('labels groups only when there is more than one', () => {
    expect(picker()).not.toContain('picker-group');
    const html = picker({ favorites: favorites({ ids: new Set([b]) }) });
    expect(html.match(/class="picker-group"/g)).toHaveLength(2);
    expect(html.indexOf('>Favorites<')).toBeLessThan(html.indexOf('>Repositories<'));
    expect(html).toContain('aria-label="ada/docs, public, favorite"');
  });

  it('shows the footer, and each empty state in words', () => {
    const html = picker();
    expect(html).toContain('New repository');
    expect(html).toContain('href="/repositories"');
    expect(html).toContain('View all repositories');
    expect(picker({ rows: [], current: undefined })).toContain('No repositories yet.');
    expect(picker({ rows: [], current: undefined, loading: true })).toContain(
      'Loading repositories',
    );
    expect(picker({ rows: [], current: undefined, error: 'failed' })).toContain(
      'could not be read',
    );
  });

  it('shows a failed save, open or closed', () => {
    const refused = favorites({ error: 'You can keep 50 favorites' });
    expect(picker({ favorites: refused })).toContain('You can keep 50 favorites');
    expect(picker({ favorites: refused, open: false })).toContain('You can keep 50 favorites');
  });

  it('adds a favorite from no row of its own', () => {
    const extra = { repo: 'r0000000000000000000c', name: 'compiler', owner: 'ada' };
    const html = picker({ favorites: favorites({ ids: new Set([extra.repo]), rows: [extra] }) });
    expect(html).toContain('ada/compiler');
  });

  it('closes on the open repository name, truncated with its title', () => {
    const html = picker({ open: false, currentName: 'parser' });
    expect(html).toContain('title="parser"');
    expect(html).toContain('Switch repository (current: parser)');
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain('role="listbox"');
  });
});

describe('icon rail', () => {
  const rail = (props: object) =>
    renderToStaticMarkup(
      createElement(AppRail, {
        authenticated: true,
        route: home,
        collapsed: false,
        onToggle: () => {},
        navigate: () => {},
        onNew: () => {},
        onImport: () => {},
        ...props,
      }),
    );

  it("offers Browse, the open repository's Changes, Search, New and the collapse toggle", () => {
    const html = rail({ route: { view: 'files', repo: a, path: '', ref: 'main' } });
    expect(html).toContain('aria-label="Browse"');
    expect(html).toContain(`href="/source/${a}/changes"`);
    expect(html).toContain('href="/search"');
    expect(html).toContain('aria-label="New repository"');
    expect(html).toContain('aria-label="Collapse sidebar"');
    expect(html).toContain('aria-expanded="true"');
    expect(rail({ collapsed: true })).toContain('aria-label="Expand sidebar"');
  });

  it('sends Changes to the repository list when no repository is open, Search to its page', () => {
    const html = rail({});
    expect(html.match(/href="\/repositories"/g)).toHaveLength(1);
    expect(html).toContain('href="/search"');
    expect(rail({ authenticated: false })).toContain('href="/search"');
    expect(rail({ authenticated: false })).not.toContain('New repository');
  });

  it("marks Search alone on the Search page, and not on a repository's own search", () => {
    const active = (route: SourceRoute) =>
      [...rail({ route }).matchAll(/class="rail-item active"[^>]*aria-label="([^"]+)"/g)].map(
        (m) => m[1],
      );
    expect(active({ view: 'global-search', q: 'retry' })).toEqual(['Search']);
    expect(active({ view: 'search', repo: a, query: '' })).toEqual([]);
    expect(active(home)).toEqual(['Browse']);
  });
});
