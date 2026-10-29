// The shell's sidebar, icon rail and repository switcher: rows named "<name>, <label>" for
// assistive technology, the open repository's pages (Settings only for its admins), Explore
// signed in or out, and the switcher's search.
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { formatSourceRoute, type SourceRoute } from '../source-platform/sourceRoute';
import { AppRail } from './AppRail';
import { AppSidebar, labelled } from './AppSidebar';
import { RepoSwitcher } from './RepoSwitcher';

const a = 'r0000000000000000000a';
const b = 'r0000000000000000000b';
const home: SourceRoute = { view: 'home' };
const sidebar = (props: object) =>
  renderToStaticMarkup(
    createElement(AppSidebar, { authenticated: true, loading: false, route: home, ...props }),
  );

describe('sidebar', () => {
  it('names a row with its label, and leaves an unlabelled row to its text', () => {
    expect(labelled('acme', 'owner')).toBe('acme, owner');
    expect(labelled('mine')).toBeUndefined();
  });

  it('labels repository and organization links', () => {
    const html = sidebar({
      rows: [
        { repo: a, name: 'shared', shared: 'ada · write' },
        { repo: b, name: 'mine' },
      ],
      orgs: [{ org: 'acme', role: 'owner' }],
    });
    expect(html).toContain('aria-label="shared, ada · write"');
    expect(html).toContain('aria-label="acme, owner"');
    expect(html).not.toContain('aria-label="mine');
    // The visible name stays in its own element (the browser gate finds org rows by it).
    expect(html).toContain('<span class="rail-repo-name">acme</span>');
    expect(html).toContain('aria-label="Repositories"');
  });

  it('badges a public repository and offers Explore signed in or out', () => {
    const html = sidebar({
      rows: [
        { repo: a, name: 'open', public: true },
        { repo: b, name: 'closed' },
      ],
    });
    expect(html).toContain('aria-label="open, public"');
    expect(html.split('rail-repo-public').length - 1).toBe(1);
    expect(html).toContain('href="/source/explore"');
    const out = sidebar({ authenticated: false, route: { view: 'explore' } });
    expect(out).toMatch(/aria-current="page" class="active" href="\/source\/explore"/);
    expect(out).not.toContain('New repository');
    expect(out).not.toContain('aria-label="Repositories"');
    expect(out).not.toContain('Choose a repository');
  });

  it("lists the open repository's pages, Settings only for its admins", () => {
    const route: SourceRoute = { view: 'agents', repo: a, section: 'sessions' };
    const html = sidebar({ route, rows: [{ repo: a, name: 'parser' }] });
    const pages = [...html.matchAll(/<span class="side-text">([A-Za-z ]+)<\/span>/g)].map(
      (m) => m[1],
    );
    expect(pages).toEqual([
      'Home',
      'Repositories',
      'Explore',
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
    // Not on a repository: the switcher only.
    expect(sidebar({})).toContain('Choose a repository');
    expect(sidebar({})).not.toContain('aria-label="Repository"');
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
    [{ view: 'agents', repo: a, section: 'managed' }, 'Agent tools'],
    [{ view: 'agents', repo: a, section: 'runs', agent: 'code-review' }, 'Agent tools'],
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

describe('a repository that is gone', () => {
  // Deleted while open (the next read answered GONE) or reached by a stale link to one of its
  // pages: no Repository pages and no current entry, only the account's repositories.
  for (const route of [
    { view: 'changes', repo: a },
    { view: 'agents', repo: a, section: 'sessions' },
  ] as SourceRoute[])
    it(`hides the Repository pages on ${route.view}`, () => {
      const html = sidebar({ route, missing: true, rows: [{ repo: b, name: 'mine' }] });
      expect(html).not.toContain('aria-label="Repository"');
      expect(html).not.toContain(`href="/source/${a}`);
      expect(html).toContain('Choose a repository');
      expect(html).toContain('aria-label="Repositories"');
      expect(html).toContain(`href="/source/${b}"`);
      const shortcuts = renderToStaticMarkup(
        createElement(AppRail, {
          authenticated: true,
          route,
          missing: true,
          collapsed: false,
          onToggle: () => {},
          navigate: () => {},
          onNew: () => {},
        }),
      );
      expect(shortcuts).not.toContain(`href="/source/${a}`);
    });
});

describe('repository switcher', () => {
  it('opens on a search over the rows and marks the open one', () => {
    const html = renderToStaticMarkup(
      createElement(RepoSwitcher, {
        rows: [
          { repo: a, name: 'parser' },
          { repo: b, name: 'docs', shared: 'ada · read' },
        ],
        current: a,
        navigate: () => {},
        initiallyOpen: true,
      }),
    );
    expect(html).toContain('aria-expanded="true"');
    expect(html).toContain('aria-label="Find a repository"');
    expect(html).toMatch(/aria-current="page" href="\/source\/r0+a"/);
    expect(html).toContain(`href="/source/${b}"`);
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
        ...props,
      }),
    );

  it("offers Browse, the open repository's Changes and Search, New and the collapse toggle", () => {
    const html = rail({ route: { view: 'files', repo: a, path: '', ref: 'main' } });
    expect(html).toContain('aria-label="Browse"');
    expect(html).toContain(`href="/source/${a}/changes"`);
    expect(html).toContain(`href="/source/${a}/search"`);
    expect(html).toContain('aria-label="New repository"');
    expect(html).toContain('aria-label="Collapse sidebar"');
    expect(html).toContain('aria-expanded="true"');
    expect(rail({ collapsed: true })).toContain('aria-label="Expand sidebar"');
  });

  it('sends Changes and Search to the repository list when no repository is open', () => {
    const html = rail({});
    expect(html.match(/href="\/repositories"/g)).toHaveLength(2);
    expect(rail({ authenticated: false })).not.toContain('New repository');
  });
});
