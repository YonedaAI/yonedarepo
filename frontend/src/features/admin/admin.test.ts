// The admin pages: their addresses (each section, a user by account name, unknown sections
// back to the overview), the sign-ups unread marker, the 30-day bars and the labels the
// tables show; the sidebar's Admin entry only for operators, with the unread badge.
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { SiteTraffic } from '../../../../shared/site-traffic';
import { AppSidebar } from '../shell/AppSidebar';
import {
  formatSourceRoute,
  parseSourceRoute,
  type SourceRoute,
} from '../source-platform/sourceRoute';
import { AdminRoot } from './AdminRoot';
import { PlatformClients, TrafficCheck, TrafficHeadlineCards } from './AdminTrafficCheck';
import {
  accountsPath,
  countryName,
  dbSize,
  providerLabel,
  readSeen,
  reposPath,
  saveSeen,
  signupsPath,
  storageAlert,
  unreadLabel,
} from './adminModel';
import {
  barHeights,
  barLayout,
  changeLabel,
  dayBars,
  figure,
  trafficBars,
  trafficEmpty,
  trafficNote,
} from './trafficModel';

const bucket = (start: string, end: string) => ({
  start,
  end,
  humans: 3,
  agents: 40,
  bots: 0,
  estimated: ['agents' as const],
});

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

  it('lays out bars with a gap and draws nothing for an empty one', () => {
    const [none, half, full] = barLayout([0, 2, 4], 300, 100);
    expect(none.path(110)).toBe('');
    expect([half.x, half.width, half.height]).toEqual([101, 98, 50]);
    expect([full.x, full.height]).toEqual([201, 100]);
    expect(full.path(110)).toMatch(/^M201 110V13Q201 10 204 10H296Q299 10 299 13V110Z$/);
    // Narrow slots keep a visible bar, and an empty chart has no bars.
    expect(barLayout([1, 1], 2, 10)[0].width).toBe(1);
    expect(barLayout([], 100, 10)).toEqual([]);
  });

  it('marks an estimate, and only an estimate, with ≈', () => {
    expect(figure(1234.4)).toBe('1,234');
    expect(figure(1234.4, true)).toBe('≈1,234');
  });

  it('names a bar by its hour, day or week, and carries its estimate', () => {
    const hour = bucket('2026-10-30T14:00:00.000Z', '2026-10-30T15:00:00.000Z');
    expect(trafficBars({ series: [hour], bucket: 'hour' }, 'agents')).toEqual([
      {
        key: hour.start,
        label: 'Oct 30, 14:00 UTC',
        axis: '14:00',
        value: 40,
        estimated: true,
      },
    ]);
    const day = bucket('2026-10-30T00:00:00.000Z', '2026-10-31T00:00:00.000Z');
    expect(trafficBars({ series: [day], bucket: 'day' }, 'humans')[0]).toMatchObject({
      label: 'Oct 30',
      axis: 'Oct 30',
      value: 3,
      estimated: false,
    });
    const week = bucket('2026-10-25T00:00:00.000Z', '2026-11-01T00:00:00.000Z');
    expect(trafficBars({ series: [week], bucket: 'week' }, 'humans')[0]).toMatchObject({
      label: 'Oct 25 to Oct 31',
      axis: 'Oct 25',
    });
    expect(dayBars([{ day: '2026-10-29', count: 5 }])).toEqual([
      { key: '2026-10-29', label: 'Oct 29', axis: 'Oct 29', value: 5 },
    ]);
  });

  it('compares with the period before in one short caption', () => {
    expect(changeLabel(120, 100, '7d')).toBe('+20% on the previous 7 days');
    expect(changeLabel(50, 100, '24h')).toBe('−50% on the previous 24 hours');
    expect(changeLabel(120, 100, '30d', true)).toBe('≈+20% on the previous 30 days');
    expect(changeLabel(100, 100, '7d')).toBe('Level with the previous 7 days');
    expect(changeLabel(1000, 1001, '7d')).toBe('Level with the previous 7 days');
    expect(changeLabel(0, 0, '7d')).toBe('Level with the previous 7 days');
    expect(changeLabel(9, 0, '7d')).toBe('Up from 0 in the previous 7 days');
  });

  it('names countries, and keeps a code it cannot name', () => {
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

describe('admin traffic labels', () => {
  const check = (web_analytics: object) =>
    renderToStaticMarkup(
      createElement(TrafficCheck, {
        range: '7d',
        humans: 1234,
        counting: true,
        web_analytics,
      } as never),
    );
  const cards = (counting: boolean) =>
    renderToStaticMarkup(
      createElement(TrafficHeadlineCards, {
        counting,
        headline: {
          humans: 40,
          humans_signed_in: 6,
          agents_site: 9,
          agents_platform: 1200,
          bots: 52,
          crawlers: 7,
          estimated: [],
        },
        previous: null,
        range: '7d',
      }),
    );
  const now = Date.UTC(2026, 10, 2, 12);

  it('says when a window is only partly counted, and never reads off as zero', () => {
    const headline = { estimated: [] } as unknown as SiteTraffic['headline'];
    const report = { counting: true, classed_since: '2026-10-31', days: 7, headline } as const;
    expect(trafficNote(report, now)).toEqual({
      warn: true,
      text: 'Counted since 2026-10-31: 3 of these 7 days.',
    });
    expect(trafficNote({ ...report, classed_since: '2026-10-01' }, now)).toEqual({
      warn: false,
      text: 'Page views, not unique visitors.',
    });
    expect(
      trafficNote(
        {
          ...report,
          classed_since: '2026-10-01',
          headline: { estimated: ['agents'] } as unknown as SiteTraffic['headline'],
        },
        now,
      ).text,
    ).toContain('≈ is an estimate');
    expect(trafficNote({ ...report, classed_since: null }, now).text).toBe('Nothing counted yet.');
    const off = trafficNote({ ...report, counting: false }, now);
    expect(off.warn).toBe(true);
    expect(off.text).toContain('unknown, not zero');
  });

  it('keeps every line of the page within the reading width', () => {
    const long = '2026-10-31';
    for (const [counting, classed_since] of [
      [false, long],
      [true, null],
      [true, long],
    ] as const)
      expect(
        trafficNote(
          {
            counting,
            classed_since,
            days: 30,
            headline: { estimated: ['agents'] } as unknown as SiteTraffic['headline'],
          },
          now,
        ).text.length,
      ).toBeLessThanOrEqual(76);
  });

  it('heads the page with three short classes, signed-in humans shown apart', () => {
    const html = cards(true);
    expect(html).toContain('Humans');
    expect(html).toContain('6 signed in, 34 signed out');
    expect(html).toContain('1,209');
    expect(html).toContain('9 on the site, 1,200 on the platform');
    expect(html).toContain('>Bots<');
    expect(
      renderToStaticMarkup(
        createElement(TrafficHeadlineCards, {
          counting: true,
          previous: null,
          range: '7d',
          headline: {
            humans: 0,
            humans_signed_in: 0,
            agents_site: 0,
            agents_platform: 0,
            bots: 1,
            crawlers: 1,
            estimated: [],
          },
        }),
      ),
    ).toContain('1 search crawler, 0 unconfirmed');
    expect(html).toContain('7 search crawlers, 45 unconfirmed');
    expect(html).toContain('admin-tiles-three');
  });

  const headline = {
    humans: 40,
    humans_signed_in: 6,
    agents_site: 9,
    agents_platform: 1200,
    bots: 52,
    crawlers: 7,
  };

  it('compares each card with the period before, and marks the estimates', () => {
    const html = renderToStaticMarkup(
      createElement(TrafficHeadlineCards, {
        counting: true,
        range: '7d',
        headline: { ...headline, estimated: ['agents'] },
        previous: { ...headline, humans: 20, agents_platform: 300, bots: 52, estimated: [] },
      }),
    );
    expect(html).toContain('+100% on the previous 7 days');
    expect(html).toContain('≈1,209');
    expect(html).toContain('≈+291% on the previous 7 days');
    expect(html).toContain('Level with the previous 7 days');
  });

  it('claims no comparison without a whole period before', () => {
    const html = renderToStaticMarkup(
      createElement(TrafficHeadlineCards, {
        counting: true,
        range: '90d',
        headline: { ...headline, estimated: [] },
        previous: null,
      }),
    );
    expect(html).not.toContain('previous');
  });

  it('shows Humans as unknown where nothing is counting', () => {
    const html = cards(false);
    expect(html).toContain('—');
    expect(html).toContain('Not counted here yet');
    expect(html).not.toContain('>40<');
  });

  it('has nothing to show only when every part of the report is empty', () => {
    const empty = {
      headline: {
        humans: 0,
        humans_signed_in: 0,
        agents_site: 0,
        agents_platform: 0,
        bots: 0,
        crawlers: 0,
      },
      series: [],
      campaigns: [],
      signups: [],
    } as never as SiteTraffic;
    expect(trafficEmpty(empty)).toBe(true);
    // Zero bars are still nothing: a range always has its bars.
    expect(
      trafficEmpty({ ...empty, series: [{ ...bucket('a', 'b'), humans: 0, agents: 0 }] }),
    ).toBe(true);
    expect(trafficEmpty({ ...empty, headline: { ...empty.headline, bots: 1 } })).toBe(false);
    expect(
      trafficEmpty({
        ...empty,
        series: [{ ...bucket('a', 'b'), humans: 0, agents: 1 }],
      }),
    ).toBe(false);
  });

  it('names each client kind and shows what a token proved', () => {
    const rows = [
      { client: 'cli', operation: 'land', count: 1500, with_token: 1400, estimated: false },
    ];
    const html = renderToStaticMarkup(
      createElement(PlatformClients, { range: '7d', clients: rows, counting: true }),
    );
    expect(html).toContain('yoneda CLI');
    expect(html).toContain('land');
    expect(html).toContain('1,500');
    expect(html).toContain('1,400');
    const empty = (counting: boolean) =>
      renderToStaticMarkup(createElement(PlatformClients, { range: '7d', clients: [], counting }));
    expect(empty(true)).toContain('No platform requests in this range.');
    expect(empty(false)).toContain('Not counted here yet.');
    expect(empty(true)).not.toContain('<table');
  });

  it('sets the signed-out count beside what Web Analytics saw', () => {
    const html = check({ ok: true, host: 'yonedarepo.com', page_loads: 56, visits: 7 });
    expect(html).toContain('Humans, signed out');
    expect(html).toContain('Web Analytics page loads');
    expect(html).toContain('Web Analytics visits');
    expect(html).toContain('1,234');
  });

  it('shows one line, no table, when Web Analytics has nothing to compare', () => {
    const failed = check({ ok: false, reason: 'query_failed' });
    expect(failed).toContain('Web Analytics could not be read');
    expect(failed).not.toContain('<table');
    expect(check({ ok: false, reason: 'not_configured' })).toContain('not set up here');
    const off = renderToStaticMarkup(
      createElement(TrafficCheck, {
        range: '7d',
        humans: 0,
        counting: false,
        web_analytics: { ok: true, host: 'x', page_loads: 12, visits: 3 },
      }),
    );
    expect(off).toContain('Not counted here yet.');
    expect(off).not.toContain('<table');
  });
});
