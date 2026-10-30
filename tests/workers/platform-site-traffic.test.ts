// Site traffic reports (platform Worker): the Analytics Engine SQL the admin Traffic page runs,
// and how its answers and failures come back. The SQL API is simulated; no token is real.
import { expect, it, vi } from 'vitest';
import { siteTraffic, trafficQueries } from '../../cloudflare/worker/platform-site-traffic';
import type { Env } from '../../cloudflare/worker/types';

const configured = {
  CF_ACCOUNT_ID: 'f011d0ee02b23cad26b4b38151b204ad',
  SITE_EVENTS_DATASET: 'yonedarepo_dev_site_events',
  ANALYTICS_READ_TOKEN: 'test-read-token',
} as unknown as Env;

it('builds bot-free, windowed queries over the one dataset', () => {
  const q = trafficQueries('yonedarepo_dev_site_events', 7);
  expect(q.views_by_day).toBe(
    "SELECT formatDateTime(toStartOfInterval(timestamp, INTERVAL '1' DAY), '%Y-%m-%d') AS day, SUM(_sample_interval) AS views FROM yonedarepo_dev_site_events WHERE blob1 = 'pageview' AND double1 = 0 AND timestamp > NOW() - INTERVAL '30' DAY GROUP BY day ORDER BY day ASC FORMAT JSON",
  );
  expect(q.top_pages).toBe(
    "SELECT blob2 AS key, SUM(_sample_interval) AS count FROM yonedarepo_dev_site_events WHERE blob1 = 'pageview' AND double1 = 0 AND timestamp > NOW() - INTERVAL '7' DAY GROUP BY key ORDER BY count DESC LIMIT 25 FORMAT JSON",
  );
  expect(q.top_referrers).toContain("blob3 AS key");
  expect(q.top_referrers).toContain("AND blob3 != ''");
  expect(q.countries).toContain('blob4 AS key');
  expect(q.campaigns).toContain("GROUP BY utm_source, utm_medium, utm_campaign");
  expect(q.campaigns).toContain("AND (blob6 != '' OR blob7 != '' OR blob8 != '')");
  expect(q.signups_7).toContain("WHERE blob1 = 'signup' AND timestamp > NOW() - INTERVAL '7' DAY");
  expect(q.signups_30).toContain("INTERVAL '30' DAY");
  for (const sql of Object.values(q)) {
    expect(sql).toContain('FROM yonedarepo_dev_site_events ');
    expect(sql).toMatch(/FORMAT JSON$/);
  }
  for (const sql of [q.top_pages, q.top_referrers, q.countries, q.campaigns])
    expect(sql).toContain("INTERVAL '7' DAY");
  expect(() => trafficQueries('x; DROP TABLE y', 7)).toThrow();
  expect(() => trafficQueries('yonedarepo-dev-site-events', 30)).toThrow();
});

it('runs every query against the SQL API with the read token and shapes the answers', async () => {
  const sent: { url: string; auth: string | null; body: string }[] = [];
  const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
    const body = String(init?.body);
    sent.push({ url, auth: new Headers(init?.headers).get('authorization'), body });
    const data = body.includes('AS day')
      ? [{ day: '2026-10-29', views: '12' }, { day: '2026-10-30', views: 3 }]
      : body.includes("blob1 = 'signup'")
        ? [{ provider: 'github', referrer: 'news.ycombinator.com', utm_source: 'hn', utm_campaign: '', count: '2' }]
        : body.includes('utm_medium')
          ? [{ utm_source: 'hn', utm_medium: 'social', utm_campaign: 'launch', count: '5' }]
          : [{ key: '/pricing', count: '9' }];
    return Response.json({ meta: [], data, rows: data.length });
  });
  const result = await siteTraffic(configured, 30, fetcher as unknown as typeof fetch);
  expect(sent).toHaveLength(7);
  for (const call of sent) {
    expect(call.url).toBe(
      'https://api.cloudflare.com/client/v4/accounts/f011d0ee02b23cad26b4b38151b204ad/analytics_engine/sql',
    );
    expect(call.auth).toBe('Bearer test-read-token');
  }
  expect(result).toEqual({
    ok: true,
    traffic: {
      days: 30,
      views_by_day: [
        { day: '2026-10-29', views: 12 },
        { day: '2026-10-30', views: 3 },
      ],
      top_pages: [{ key: '/pricing', count: 9 }],
      top_referrers: [{ key: '/pricing', count: 9 }],
      countries: [{ key: '/pricing', count: 9 }],
      campaigns: [{ utm_source: 'hn', utm_medium: 'social', utm_campaign: 'launch', count: 5 }],
      signups: {
        last_7: [{ provider: 'github', referrer: 'news.ycombinator.com', utm_source: 'hn', utm_campaign: '', count: 2 }],
        last_30: [{ provider: 'github', referrer: 'news.ycombinator.com', utm_source: 'hn', utm_campaign: '', count: 2 }],
      },
    },
  });
});

it('reports a missing configuration or a failed query without leaking the token', async () => {
  const never = vi.fn();
  for (const missing of ['CF_ACCOUNT_ID', 'SITE_EVENTS_DATASET', 'ANALYTICS_READ_TOKEN'] as const)
    expect(await siteTraffic({ ...configured, [missing]: undefined }, 7, never as unknown as typeof fetch)).toEqual({
      ok: false,
      reason: 'not_configured',
    });
  expect(never).not.toHaveBeenCalled();
  const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
  const refused = vi.fn(async () => new Response('{"errors":[{"message":"bad token"}]}', { status: 403 }));
  expect(await siteTraffic(configured, 7, refused as unknown as typeof fetch)).toEqual({
    ok: false,
    reason: 'query_failed',
  });
  const malformed = vi.fn(async () => Response.json({ data: 'nope' }));
  expect(await siteTraffic(configured, 7, malformed as unknown as typeof fetch)).toEqual({
    ok: false,
    reason: 'query_failed',
  });
  expect(JSON.stringify(errors.mock.calls)).not.toContain('test-read-token');
  errors.mockRestore();
});
