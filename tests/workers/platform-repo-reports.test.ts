// What repository points add up to: the SQL each report sends, how it folds, and how a report
// answers without its switch, its settings or the SQL API. The SQL API is simulated.
import { expect, it } from 'vitest';
import { foldUsage } from '../../cloudflare/worker/platform-repo-insights';
import {
  insightsQuery,
  landingLatencyQuery,
  landingTotalsQuery,
  repoUsageQuery,
} from '../../cloudflare/worker/platform-repo-queries';
import {
  foldLandings,
  landingReport,
  repoUsageReport,
} from '../../cloudflare/worker/platform-repo-reports';
import { trafficSpan } from '../../cloudflare/worker/platform-traffic-queries';
import { refusalReason } from '../../cloudflare/worker/repo-usage';
import type { Env } from '../../cloudflare/worker/types';

const D = 'events';
const NOW = Date.UTC(2026, 11, 20, 15, 30);
const REPO = 'r0123456789abcdef0123';
const span = trafficSpan('7d', NOW);
const since = 'timestamp >= toDateTime(1797206400)';
const on = {
  TRAFFIC_EVENTS: 'on',
  TRAFFIC_REPORT: 'on',
  REPO_ANALYTICS: 'on',
  SITE_EVENTS: { writeDataPoint() {} },
  CF_ACCOUNT_ID: 'f011d0ee02b23cad26b4b38151b204ad',
  SITE_EVENTS_DATASET: D,
  ANALYTICS_READ_TOKEN: 'read',
} as unknown as Env;
const query = new URLSearchParams('range=7d');

it('reads one repository by its index, in one statement', () => {
  expect(insightsQuery(D, REPO, span)).toBe(
    `SELECT formatDateTime(toStartOfInterval(timestamp, INTERVAL '1' DAY), '%Y-%m-%dT%H') AS bucket, blob15 AS actor, blob16 AS reason, blob17 AS detail, SUM(_sample_interval) AS count, MAX(_sample_interval) AS sampling FROM ${D} WHERE index1 = '${REPO}' AND blob1 IN ('client', 'repo') AND double5 = 1 AND blob17 IN ('clone', 'fetch', 'base', 'branch', 'landed', 'already', 'refused', 'failed') AND ${since} GROUP BY bucket, actor, reason, detail ORDER BY bucket ASC FORMAT JSON`,
  );
});

it('refuses anything but a repository id in a statement', () => {
  expect(() => insightsQuery(D, "r' OR 1=1 --", span)).toThrow('Invalid repository id');
});

it('asks for weighted percentiles as Analytics Engine documents them', () => {
  expect(landingLatencyQuery(D, span)).toContain(
    'quantileExactWeighted(0.95)(double6, _sample_interval) AS p95',
  );
  expect(landingLatencyQuery(D, span)).toContain(
    'quantileExactWeighted(0.5)(double8, _sample_interval) AS queue_p50',
  );
  expect(landingLatencyQuery(D, span)).toContain("blob17 = 'landed'");
  expect(landingTotalsQuery(D, span)).toContain('SUM(_sample_interval * double9) AS retries');
  expect(repoUsageQuery(D, span, 'pushed_bytes')).toContain('ORDER BY pushed_bytes DESC');
});

const row = (detail: string, count: number, more: object = {}) => ({
  bucket: '2026-12-20T00',
  actor: 'repo_token',
  reason: '',
  detail,
  count,
  sampling: 1,
  ...more,
});

it('folds a repository into totals, bars, who and why', () => {
  const usage = foldUsage(
    [
      row('clone', 3, { actor: 'anonymous' }),
      row('fetch', 2),
      row('branch', 1),
      row('base', 1),
      row('landed', 5, { actor: 'person' }),
      row('already', 9),
      row('refused', 2, { reason: 'needs_approval', sampling: 4 }),
      row('failed', 1, { reason: 'timeout' }),
    ],
    span,
  );
  expect(usage).toMatchObject({
    clones: 3,
    fetches: 2,
    pushes: 2,
    landings: 5,
    failed_landings: 3,
    estimated: true,
  });
  expect(usage.who).toEqual([
    { key: 'token', count: 7, estimated: true },
    { key: 'person', count: 5, estimated: false },
    { key: 'anonymous', count: 3, estimated: false },
  ]);
  expect(usage.reasons[0]).toEqual({ key: 'needs_approval', count: 2, estimated: true });
  expect(usage.series).toHaveLength(7);
  expect(usage.series.at(-1)).toMatchObject({ clones: 3, pushes: 2, landings: 5, failed: 3 });
  expect(usage.series[0]).toMatchObject({ clones: 0, landings: 0, estimated: false });
});

it('works out the success rate over landed, refused and failed, and pushes apart', () => {
  const report = foldLandings(
    '7d',
    [
      { reason: '', detail: 'landed', count: 6, retries: 2, sampling: 1 },
      { reason: 'conflict', detail: 'refused', count: 3, retries: 0, sampling: 1 },
      { reason: 'timeout', detail: 'failed', count: 1, retries: 1, sampling: 1 },
      { reason: '', detail: 'already', count: 2, retries: 0, sampling: 1 },
      { reason: '', detail: 'base', count: 4, retries: 0, sampling: 1 },
      { reason: 'needs_approval', detail: 'base', count: 1, retries: 0, sampling: 1 },
      { reason: '', detail: 'branch', count: 7, retries: 0, sampling: 1 },
      { reason: '', detail: 'check:pass', count: 8, retries: 0, sampling: 1 },
      { reason: '', detail: 'check:fail', count: 2, retries: 0, sampling: 1 },
    ],
    [{ p50: 100, p95: '900', p99: 1500, queue_p50: 0, queue_p95: 40 }],
  );
  expect(report).toMatchObject({
    landed: 6,
    refused: 3,
    failed: 1,
    success_rate: 0.6,
    latency: { p50: 100, p95: 900, p99: 1500 },
    queue: { p50: 0, p95: 40 },
    retries: 5,
    checks: { run: 10, failed: 2 },
    direct_pushes: { total: 5, refused: 1 },
  });
  expect(report.reasons.map((r) => r.key)).toEqual(['conflict', 'timeout']);
});

it('has no rate or times with nothing to work them from', () => {
  const report = foldLandings('7d', [], [{ p50: 'nan' }]);
  expect(report).toMatchObject({ success_rate: null, latency: null, queue: null });
});

it('answers off, not set up and failed apart', async () => {
  const off = { ...on, REPO_ANALYTICS: undefined } as Env;
  expect(await landingReport(off, query)).toEqual({ ok: false, reason: 'off' });
  expect(await repoUsageReport(off, query)).toEqual({ ok: false, reason: 'off' });
  const bare = { ...on, ANALYTICS_READ_TOKEN: undefined } as Env;
  expect(await landingReport(bare, query)).toEqual({ ok: false, reason: 'not_configured' });
  const down = async () => new Response('', { status: 500 });
  expect(await landingReport(on, query, down as typeof fetch, NOW)).toEqual({
    ok: false,
    reason: 'query_failed',
  });
  expect(await repoUsageReport(on, query, down as typeof fetch, NOW)).toEqual({
    ok: false,
    reason: 'query_failed',
  });
});

it('names a repository and leaves out what is gone or ours', async () => {
  const names = [
    { id: 'rmine', name: 'site', owner: 'alice', handle: 'alice', visibility: 'private' },
  ];
  const INDEX = {
    prepare: () => ({ bind: () => ({ all: async () => ({ results: names }) }) }),
  } as unknown as D1Database;
  const sql = async () =>
    Response.json({
      data: [
        { repo: 'rmine', actions: 9, pushed_bytes: '2048', sampling: 1 },
        { repo: 'rgone', actions: 8, pushed_bytes: 9, sampling: 1 },
      ],
    });
  const answer = await repoUsageReport({ ...on, INDEX }, query, sql as typeof fetch, NOW);
  expect(answer).toMatchObject({
    ok: true,
    report: {
      most_active: [{ id: 'rmine', actions: 9, pushed_bytes: 2048, visibility: 'private' }],
      fastest_growing: [{ id: 'rmine' }],
    },
  });
});

it.each([
  ['a reviewer rejected it; checks failed: unit', 'rejected'],
  ['checks failed: unit; waiting for checks: e2e', 'checks_failed'],
  ['2 open findings; waiting for checks: e2e', 'open_findings'],
  ['waiting for checks: e2e', 'checks_missing'],
  ['needs 1 approval from another person, has 0', 'needs_approval'],
  ['the landing rules are not met', 'not_ready'],
])('reads the gate %s as %s', (gate, reason) => {
  const e = { code: 'NOT_READY', message: `Commit cannot land yet: ${gate}` };
  expect(refusalReason(e)).toBe(reason);
});

it('keeps a reason to a short word from the error code', () => {
  expect(refusalReason({ code: 'STALE_HEAD' })).toBe('stale_head');
  expect(refusalReason({ code: 'a b/c' })).toBe('unknown');
  expect(refusalReason(new Error('plain'))).toBe('unknown');
});

// The real SQL API rejects mixed IF branch types even when no row needs the branch.
// This contract fixture preserves that observed failure without provider credentials.
it.each(['7d', '30d', '90d'])('repository rankings use matching numeric branches over %s', async (range) => {
  const calls: string[] = [];
  const typedSql = async (_url: RequestInfo | URL, init?: RequestInit) => {
    const sql = String(init?.body);
    calls.push(sql);
    const fallback = /if\([\s\S]*?,\s*double\d+,\s*([\d.]+)\)/i.exec(sql)?.[1];
    if (!fallback || !fallback.includes('.'))
      return new Response('Input was invalid: IF branches had Double and Integer', { status: 422 });
    return Response.json({ data: [] });
  };
  const INDEX = {
    prepare: () => ({ bind: () => ({ all: async () => ({ results: [] }) }) }),
  } as unknown as D1Database;
  expect(await repoUsageReport({ ...on, INDEX }, new URLSearchParams({ range }), typedSql as typeof fetch, NOW)).toMatchObject({
    ok: true,
    report: { range, most_active: [], fastest_growing: [] },
  });
  expect(calls).toHaveLength(2);
  expect(calls[0]).toContain('ORDER BY actions DESC');
  expect(calls[1]).toContain('ORDER BY pushed_bytes DESC');
});
