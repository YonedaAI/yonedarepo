// Visitors (VISITORS): the hash lasts a day and holds no address, a ping with no salt still counts,
// the salt's old days are gone, a sign-up keeps its source, and the report's SQL and folds. No
// cookie is set anywhere. Analytics Engine is simulated, so its SQL is proven only on dev.
import { env as bound } from 'cloudflare:workers';
import { beforeEach, expect, it, vi } from 'vitest';
import visitorsMigration from '../../cloudflare/migrations/0016_platform_visitors.sql?raw';
import { accountCreated } from '../../cloudflare/worker/platform-accounts';
import { trafficSpan } from '../../cloudflare/worker/platform-traffic-queries';
import {
  foldVisitors,
  visitorQuery,
  visitorReport,
} from '../../cloudflare/worker/platform-visitor-report';
import { visitorSalt } from '../../cloudflare/worker/platform-visitor-salt';
import { sitePing } from '../../cloudflare/worker/site-ping';
import {
  browserOf,
  forgetVisitorSalt,
  visitorHash,
  withSource,
} from '../../cloudflare/worker/site-visitors';
import type { Env } from '../../cloudflare/worker/types';
import { scoped, usePlatformFixture } from './repo-fixture';

usePlatformFixture();
beforeEach(forgetVisitorSalt);

const NOW = Date.UTC(2026, 10, 2, 12);
const DAY = 86_400_000;
const db = (bound as unknown as { INDEX: D1Database }).INDEX;
const on = { ...scoped, VISITORS: 'on' } as unknown as Env;
const platform = (salt: () => Promise<string>) =>
  ({ VISITORS: 'on', PLATFORM: { visitorSalt: salt } }) as unknown as Env;
const browser = (address: string, agent: string) =>
  new Request('https://yonedarepo.test/api/e', {
    method: 'POST',
    headers: { 'cf-connecting-ip': address, 'user-agent': agent },
  });

it('gives one browser one hash for the day, and another browser another', async () => {
  const env = platform(async () => 'salt-a');
  const one = await visitorHash(browser('203.0.113.1', 'Firefox/1'), env, NOW);
  expect(one).toMatch(/^[0-9a-f]{32}$/);
  expect(await visitorHash(browser('203.0.113.1', 'Firefox/1'), env, NOW + 1000)).toBe(one);
  expect(await visitorHash(browser('203.0.113.2', 'Firefox/1'), env, NOW)).not.toBe(one);
  expect(await visitorHash(browser('203.0.113.1', 'Chrome/1'), env, NOW)).not.toBe(one);
});

it('changes the hash the next day, asking for a salt once a day', async () => {
  const salts = ['monday', 'tuesday'];
  const salt = vi.fn(async () => salts.shift() as string);
  const env = platform(salt);
  const req = () => browser('203.0.113.1', 'Firefox/1');
  const monday = await visitorHash(req(), env, NOW);
  await visitorHash(req(), env, NOW + 1000);
  expect(salt).toHaveBeenCalledTimes(1);
  expect(await visitorHash(req(), env, NOW + DAY)).not.toBe(monday);
  expect(salt).toHaveBeenCalledTimes(2);
});

it('gives no hash without a salt, and waits a minute before asking again', async () => {
  const salt = vi.fn(async () => {
    throw new Error('down');
  });
  const env = platform(salt);
  const req = () => browser('203.0.113.1', 'Firefox/1');
  expect(await visitorHash(req(), env, NOW)).toBe(null);
  await visitorHash(req(), env, NOW + 30_000);
  expect(salt).toHaveBeenCalledTimes(1);
  await visitorHash(req(), env, NOW + 61_000);
  expect(salt).toHaveBeenCalledTimes(2);
});

it('makes a salt once, shares it, and keeps only two days', async () => {
  const today = new Date(NOW).toISOString().slice(0, 10);
  const yesterday = new Date(NOW - DAY).toISOString().slice(0, 10);
  await db.prepare("INSERT INTO platform_visitor_salts VALUES('2026-01-01','old')").run();
  const first = await visitorSalt(on, today, NOW);
  expect(first).toMatch(/^[0-9a-f]{64}$/);
  expect(await visitorSalt(on, today, NOW)).toBe(first);
  await visitorSalt(on, yesterday, NOW);
  const { results } = await db.prepare('SELECT day FROM platform_visitor_salts ORDER BY day').all();
  expect(results).toEqual([{ day: yesterday }, { day: today }]);
  await expect(visitorSalt(on, '2026-01-01', NOW)).rejects.toThrow('No such salt');
  await expect(visitorSalt(scoped, today, NOW)).rejects.toThrow('No such salt');
});

it.each([
  ['Mozilla/5.0 Chrome/120.0 Safari/537.36 Edg/120.0', 'Edge'],
  ['Mozilla/5.0 Chrome/120.0 Safari/537.36 OPR/105', 'Opera'],
  ['Mozilla/5.0 Chrome/120.0 Safari/537.36', 'Chrome'],
  ['Mozilla/5.0 Version/17.1 Safari/605.1.15', 'Safari'],
  ['Mozilla/5.0 Gecko/20100101 Firefox/120.0', 'Firefox'],
  ['Something else', 'Other'],
])('reads %s as %s', (agent, name) => expect(browserOf(agent)).toBe(name));

const AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_6) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15';
function ping(env: Partial<Env>) {
  const points: AnalyticsEngineDataPoint[] = [];
  const merged = {
    TRAFFIC_EVENTS: 'on',
    SITE_EVENTS: { writeDataPoint: (p: AnalyticsEngineDataPoint) => points.push(p) },
    ...env,
  } as unknown as Env;
  const req = new Request('https://yonedarepo.test/api/e', {
    method: 'POST',
    headers: {
      origin: 'https://yonedarepo.test',
      'sec-fetch-site': 'same-origin',
      'sec-fetch-mode': 'cors',
      'sec-fetch-dest': 'empty',
      'cf-connecting-ip': '203.0.113.7',
      'user-agent': AGENT,
    },
    body: JSON.stringify({ path: '/explore', referrer: 'news.example.com' }),
  });
  return { points, answer: sitePing(req, merged) };
}

it('puts the hash on a ping as its index, and no cookie, address or user agent', async () => {
  const { points, answer } = ping({ VISITORS: 'on', PLATFORM: { visitorSalt: async () => 'salt' } as never });
  const res = await answer;
  expect(res.status).toBe(204);
  expect(res.headers.has('set-cookie')).toBe(false);
  expect(points).toHaveLength(1);
  expect(points[0].indexes?.[0]).toMatch(/^[0-9a-f]{32}$/);
  expect(points[0].blobs?.[10]).toBe('Safari');
  const stored = JSON.stringify(points[0]);
  expect(stored).not.toContain('203.0.113.7');
  expect(stored).not.toContain('Mozilla');
});

it('writes the same ping as today with the switch off, or with no salt', async () => {
  const off = ping({});
  await off.answer;
  expect(off.points[0].indexes).toEqual(['ping']);
  expect(off.points[0].blobs).toHaveLength(10);
  const lost = ping({
    VISITORS: 'on',
    PLATFORM: { visitorSalt: () => Promise.reject(new Error('down')) } as never,
  });
  await lost.answer;
  expect(lost.points).toHaveLength(1);
  expect(lost.points[0].indexes).toEqual(['ping']);
});

const span = trafficSpan('7d', NOW);
const row = (visitor: string, at: number, more: object = {}) => ({
  visitor,
  slot: Math.floor(at / 1000),
  entry: '/',
  exit: '/pricing',
  referrer: '',
  country: 'DE',
  device: 'desktop',
  browser: 'Chrome',
  views: 2,
  docs: 0,
  sampling: 1,
  ...more,
});

it('asks by index for one row per browser and half hour, with no distinct count', () => {
  const sql = visitorQuery('events', span);
  expect(sql).toContain('SELECT index1 AS visitor');
  expect(sql).toContain("INTERVAL '30' MINUTE");
  expect(sql).toContain('GROUP BY visitor, slot');
  expect(sql).toContain("startsWith(blob2, '/docs')");
  expect(sql).not.toContain('DISTINCT');
});

it('counts a browser once a day, each half hour as a visit, and a return as a new visitor', () => {
  const report = foldVisitors(
    [
      row('a', NOW - 3_600_000, { docs: 1 }),
      row('a', NOW, { entry: '/docs', exit: '/docs/x', referrer: 'news.example.com' }),
      row('a', NOW - DAY),
      row('b', NOW, { country: 'FR', device: 'mobile', browser: 'Safari' }),
    ],
    span,
  );
  expect(report).toMatchObject({ visitors: 3, sessions: 4, views: 8, docs: 1, estimated: false });
  expect(report.series.at(-1)?.visitors).toBe(2);
  expect(report.series.at(-2)?.visitors).toBe(1);
  expect(report.entries[0]).toEqual({ key: '/', count: 3, estimated: false });
  expect(report.exits[0].key).toBe('/pricing');
  expect(report.referrers).toEqual([{ key: 'news.example.com', count: 1, estimated: false }]);
  expect(report.countries.map((c) => c.key)).toEqual(['DE', 'FR']);
  expect(report.browsers.map((c) => c.key)).toEqual(['Chrome', 'Safari']);
});

it('marks a sampled report, or one the row limit cut, as an estimate', () => {
  expect(foldVisitors([row('a', NOW, { sampling: 4 })], span).estimated).toBe(true);
  const many = Array.from({ length: 20_000 }, (_, i) => row(`v${i}`, NOW));
  expect(foldVisitors(many, span).estimated).toBe(true);
});

it('keeps where a new account came from, cleaned, and only with the switch on', async () => {
  const source = { ref: 'NEWS.example.com', utm_source: 'launch<x>', utm_medium: '', utm_campaign: 'a' };
  await accountCreated(on, 'from_a_link', { welcome: false, source });
  await accountCreated(scoped, 'from_off', { welcome: false, source });
  await accountCreated(on, 'from_nowhere', { welcome: false, source: { ref: 'not a host' } });
  const { results } = await db
    .prepare('SELECT account,signup_ref,signup_utm_source FROM platform_accounts ORDER BY account')
    .all();
  expect(results).toEqual([
    { account: 'from_a_link', signup_ref: 'news.example.com', signup_utm_source: 'launchx' },
    { account: 'from_nowhere', signup_ref: null, signup_utm_source: null },
    { account: 'from_off', signup_ref: null, signup_utm_source: null },
  ]);
});

it('only tells the platform of a source with the switch on', () => {
  const source = { ref: 'a.example', utm_source: '', utm_medium: '', utm_campaign: '' };
  expect(withSource({} as Env, { region: 'enam' }, source)).toEqual({ region: 'enam' });
  expect(withSource({ VISITORS: 'on' } as Env, {}, source)).toEqual({ source });
  expect(withSource({ VISITORS: 'on' } as Env, { region: 'enam' }, null)).toEqual({ region: 'enam' });
});

const configured = {
  ...on,
  CF_ACCOUNT_ID: 'f011d0ee02b23cad26b4b38151b204ad',
  SITE_EVENTS_DATASET: 'events',
  ANALYTICS_READ_TOKEN: 'read',
} as unknown as Env;

it('follows accounts from sign-up to landing, leaving ours out', async () => {
  const insert = (account: string, created: number, seen: number | null, internal = 0, source = '') =>
    db
      .prepare(
        'INSERT INTO platform_accounts(account,created_at,provider,last_seen_at,internal,signup_utm_source) VALUES(?,?,?,?,?,?)',
      )
      .bind(account, created, 'email', seen, internal, source)
      .run();
  await insert('new_one', NOW - DAY, NOW, 0, 'launch');
  await insert('came_back', NOW - 3 * DAY - 7 * DAY, NOW);
  await insert('gone', NOW - 2 * DAY - 7 * DAY, NOW - 9 * DAY);
  await insert('ours', NOW - DAY, NOW, 1);
  await db
    .prepare(
      "INSERT INTO platform_repos(id,name,workspace,created_at,visibility) VALUES('r1','one','new_one',1,'private')",
    )
    .run()
    .catch(async () => {
      await db.prepare("INSERT INTO platform_repos(id,name,workspace,created_at) VALUES('r1','one','new_one',1)").run();
    });
  await db
    .prepare("INSERT INTO platform_activity(repo,summary) VALUES('r1',?)")
    .bind(JSON.stringify({ pushed: true, changes_landed_total: 0 }))
    .run();
  const sql = (async () => Response.json({ data: [row('a', NOW)] })) as unknown as typeof fetch;
  const answer = await visitorReport(configured, new URLSearchParams('range=30d'), sql, NOW);
  if (!answer.ok) throw new Error(answer.reason);
  const steps = Object.fromEntries(answer.report.funnel.map((s) => [s.step, s.count]));
  expect(steps).toEqual({ visitors: 1, docs: 0, signups: 3, repositories: 1, pushed: 1, landed: 0 });
  expect(answer.report.retention).toEqual({ cohort: 2, returned: 1 });
  expect(answer.report.campaigns).toContainEqual({ key: 'launch', signups: 1, repositories: 1 });
});

it('answers off, not set up and failed apart', async () => {
  const query = new URLSearchParams();
  expect(await visitorReport(scoped, query)).toEqual({ ok: false, reason: 'off' });
  expect(await visitorReport(on, query)).toEqual({ ok: false, reason: 'not_configured' });
  const down = (async () => new Response('', { status: 500 })) as unknown as typeof fetch;
  expect(await visitorReport(configured, query, down, NOW)).toEqual({ ok: false, reason: 'query_failed' });
});

it('upgrades the account table from before, and refuses a second run', async () => {
  const statements = visitorsMigration
    .replace(/--.*$/gm, '')
    .split(';')
    .map((s) =>
      s
        .replace(/\s+/g, ' ')
        .trim()
        .replaceAll('platform_accounts', 'old_accounts')
        .replaceAll('platform_visitor_salts', 'old_salts'),
    )
    .filter(Boolean);
  await db.exec('DROP TABLE IF EXISTS old_accounts');
  await db.exec('DROP TABLE IF EXISTS old_salts');
  await db.exec('CREATE TABLE old_accounts(account TEXT PRIMARY KEY)');
  await db.exec("INSERT INTO old_accounts VALUES('before')");
  for (const statement of statements) await db.exec(statement);
  expect(await db.prepare('SELECT signup_ref FROM old_accounts').first()).toEqual({ signup_ref: null });
  await expect(db.exec(statements[1])).rejects.toThrow(/duplicate column/i);
});
