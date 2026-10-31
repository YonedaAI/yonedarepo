// The admin pages: their addresses (each section, a user by account name, unknown sections
// back to the overview), the sign-ups unread marker, the 30-day bars and the labels the
// tables show; the sidebar's Admin entry only for operators, with the unread badge.
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { AppSidebar } from '../shell/AppSidebar';
import {
  formatSourceRoute,
  parseSourceRoute,
  type SourceRoute,
} from '../source-platform/sourceRoute';
import { AdminRoot } from './AdminRoot';
import {
  accountsPath,
  barHeights,
  countryName,
  dbSize,
  lastThirtyDays,
  providerLabel,
  readSeen,
  reposPath,
  saveSeen,
  signupsPath,
  storageAlert,
  unreadLabel,
} from './adminModel';

const parse = (path: string) => {
  const url = new URL(path, 'https://x');
  return parseSourceRoute(url.pathname, url.search);
};

describe('admin routes', () => {
  it('round-trips every section and a user, by account name', () => {
    const routes: SourceRoute[] = [
      { view: 'admin', section: 'overview' },
      { view: 'admin', section: 'users' },
      { view: 'admin', section: 'users', account: 'ada' },
      { view: 'admin', section: 'users', account: 'grace@example.com' },
      { view: 'admin', section: 'signups' },
      { view: 'admin', section: 'repos' },
      { view: 'admin', section: 'audit' },
      { view: 'admin', section: 'traffic' },
    ];
    for (const route of routes) expect(parse(formatSourceRoute(route))).toEqual(route);
    expect(formatSourceRoute({ view: 'admin', section: 'overview' })).toBe('/admin');
    expect(formatSourceRoute({ view: 'admin', section: 'users', account: 'a@b.co' })).toBe(
      '/admin/users/a%40b.co',
    );
  });

  it('sends an unknown section, or a user under another section, to the overview', () => {
    expect(parse('/admin/nope')).toEqual({ view: 'admin', section: 'overview' });
    expect(parse('/admin/repos/ada')).toEqual({ view: 'admin', section: 'repos' });
  });
});

describe('admin model', () => {
  it('builds the API paths with search and paging', () => {
    expect(accountsPath('', undefined)).toBe('/admin/accounts');
    expect(accountsPath(' ad a ', 123)).toBe('/admin/accounts?q=ad+a&before=123');
    expect(reposPath('x', undefined)).toBe('/admin/repos?q=x');
    expect(signupsPath(0)).toBe('/admin/signups?since=0');
  });

  it('shows database sizes in the units of the alert levels', () => {
    expect(dbSize(9_100_000_000)).toBe('9.1 GB');
    expect(dbSize(120_400_000)).toBe('120 MB');
    expect(dbSize(52_000)).toBe('52 KB');
  });

  it('names the alert level a repository reached', () => {
    expect(storageAlert(null)).toBeNull();
    expect(storageAlert(5_000_000_000)).toBe('Over 5 GB');
    expect(storageAlert(9_000_000_000)).toBe('Over 9 GB');
  });

  it('labels providers and caps the unread badge', () => {
    expect(providerLabel('github')).toBe('GitHub');
    expect(providerLabel('google')).toBe('Google');
    expect(providerLabel('email')).toBe('Email');
    expect(providerLabel('other')).toBe('other');
    expect(unreadLabel(0)).toBe('');
    expect(unreadLabel(7)).toBe('7');
    expect(unreadLabel(120)).toBe('99+');
  });

  it('scales the 30-day bars to the busiest day, with a visible floor for any sign-up', () => {
    expect(barHeights([0, 1, 4])).toEqual([0, 25, 100]);
    expect(barHeights([0, 0])).toEqual([0, 0]);
    expect(barHeights([1, 200])[0]).toBe(4);
  });

  it('fills the 30 days of page views ending today, and names countries', () => {
    const now = Date.UTC(2026, 9, 30, 12);
    const days = lastThirtyDays([{ day: '2026-10-29', views: 5 }], now);
    expect(days).toHaveLength(30);
    expect(days[0].day).toBe('2026-10-01');
    expect(days.at(-1)).toEqual({ day: '2026-10-30', count: 0 });
    expect(days.at(-2)).toEqual({ day: '2026-10-29', count: 5 });
    expect(countryName('DE')).toBe('Germany');
    expect(countryName('xx-not')).toBe('xx-not');
  });

  it('keeps the last look at the sign-ups, and survives storage that throws', () => {
    const store = new Map<string, string>();
    const storage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
    };
    expect(readSeen(storage)).toBe(0);
    saveSeen(1234, storage);
    expect(readSeen(storage)).toBe(1234);
    const broken = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
    };
    expect(readSeen(broken)).toBe(0);
    expect(() => saveSeen(1, broken)).not.toThrow();
  });
});

describe('sidebar admin entry', () => {
  const sidebar = (props: object) =>
    renderToStaticMarkup(
      createElement(AppSidebar, {
        authenticated: true,
        loading: false,
        route: { view: 'home' },
        ...props,
      }),
    );
  it('shows Admin to operators only, with the unread sign-ups badge', () => {
    expect(sidebar({})).not.toContain('href="/admin"');
    const html = sidebar({ admin: { unread: 3 } });
    expect(html).toContain('href="/admin"');
    expect(html).toContain('aria-label="Admin, 3 new sign-ups"');
    expect(sidebar({ admin: { unread: 0 } })).not.toContain('new sign-ups');
    const on = sidebar({ admin: { unread: 0 }, route: { view: 'admin', section: 'users' } });
    expect(on).toMatch(/aria-current="page" class="active" href="\/admin"/);
  });
});

describe('admin pages', () => {
  const page = (props: object) =>
    renderToStaticMarkup(
      createElement(AdminRoot, {
        section: 'overview',
        signups: { loading: false, reload: () => {} },
        seen: 0,
        onSeen: () => {},
        navigate: () => {},
        ...props,
      }),
    );
  it('marks the open tab and loads traffic for the 7-day window first', () => {
    const html = page({ section: 'traffic' });
    expect(html).toMatch(/aria-current="page" class="active" href="\/admin\/traffic"/);
    expect(html).toContain('Loading site traffic');
    expect(html).toContain('aria-pressed="true">7 days');
    expect(page({})).toContain('Loading the overview');
  });

  it('marks sign-ups after the last look as new, and shows the empty and error states', () => {
    const at = 2_000_000_000_000;
    const row = (account: string, created_at: number) => ({
      account,
      handle: null,
      provider: 'github',
      created_at,
      last_seen_at: null,
      repos: 0,
      suspended: false,
      suspended_at: null,
    });
    const html = page({
      section: 'signups',
      seen: at - 10,
      signups: {
        loading: false,
        reload: () => {},
        data: { items: [row('fresh', at), row('older', at - 100)], unread: 1 },
      },
    });
    expect(html).toContain('aria-label="Sign-ups, 1 new"');
    expect(html.match(/admin-status-new/g)).toHaveLength(1);
    expect(html).toContain('href="/admin/users/fresh"');
    const empty = page({
      section: 'signups',
      signups: { loading: false, reload: () => {}, data: { items: [], unread: 0 } },
    });
    expect(empty).toContain('No sign-ups yet.');
    const failed = page({
      section: 'signups',
      signups: { loading: false, reload: () => {}, error: 'Operators only' },
    });
    expect(failed).toContain('role="alert"');
  });
});
