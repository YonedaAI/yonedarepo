// The admin Operations and Infrastructure tabs: the SQL and GraphQL each sends, how the answers
// fold, and that a section that fails leaves the rest. Both APIs are simulated, so which fields
// Cloudflare really accepts is proven only on dev.
import { beforeEach, expect, it, vi } from 'vitest';
import {
  databaseFigures,
  forgetInfra,
  infraReport,
  queueRows,
  resources,
  storageFigures,
  workerRows,
} from '../../cloudflare/worker/platform-infra-report';
import {
  adminReports,
  operationsQuery,
  operationsReport,
} from '../../cloudflare/worker/platform-operations-report';
import { trafficSpan } from '../../cloudflare/worker/platform-traffic-queries';
import type { Env } from '../../cloudflare/worker/types';

const NOW = Date.UTC(2026, 11, 20, 15, 30);
const IDS = { scripts: ['p', 'f'], queues: { jobs: 'q1', 'dead-letter': 'q2' }, d1: 'd', r2: 'b' };
const on = {
  OPS_REPORT: 'on',
  OPS_RESOURCES: JSON.stringify(IDS),
  CF_ACCOUNT_ID: 'f011d0ee02b23cad26b4b38151b204ad',
  SITE_EVENTS_DATASET: 'events',
  ANALYTICS_READ_TOKEN: 'read',
} as unknown as Env;
const query = new URLSearchParams('range=7d');

beforeEach(forgetInfra);

it('asks for outcomes and percentiles by operation and client, weighted', () => {
  const sql = operationsQuery('events', trafficSpan('7d', NOW));
  expect(sql).toContain("SUM(_sample_interval * double3 * if(blob13 = 'rate_limited', 1, 0)) AS rate_limited");
  expect(sql).toContain('quantileExactWeighted(0.99)(double6, _sample_interval) AS p99');
  expect(sql).toContain("blob13 != ''");
  expect(sql).toContain('GROUP BY operation, client');
});

it('folds a row and marks an estimate', async () => {
  const sql = async () =>
    Response.json({
      data: [{ operation: 'read', client: 'git', count: '40', success: 36, failed: 4, p95: 120, sampling: 10 }],
    });
  const answer = await operationsReport(on, query, sql as typeof fetch, NOW);
  expect(answer).toMatchObject({
    ok: true,
    range: '7d',
    rows: [{ operation: 'read', count: 40, success: 36, failed: 4, p95: 120, estimated: true }],
  });
});

it('answers off, not set up and failed apart', async () => {
  const off = {} as Env;
  expect(await operationsReport(off, query)).toEqual({ ok: false, reason: 'off' });
  expect(await infraReport(off)).toEqual({ ok: false, reason: 'off' });
  expect(await operationsReport({ OPS_REPORT: 'on' } as Env, query)).toEqual({ ok: false, reason: 'not_configured' });
  expect(await infraReport({ ...on, OPS_RESOURCES: undefined })).toEqual({ ok: false, reason: 'not_configured' });
  const down = async () => new Response('', { status: 500 });
  expect(await operationsReport(on, query, down as typeof fetch, NOW)).toEqual({ ok: false, reason: 'query_failed' });
});

it.each([['not json'], ['{}'], ['{"scripts":[],"queues":{"a":1},"d1":"d","r2":"b"}'], ['{"scripts":[],"queues":{},"d1":"d"}']])(
  'refuses resources that are not all there: %s',
  (value) => expect(resources({ OPS_RESOURCES: value } as Env)).toBe(null),
);

it('says which tabs exist here', () => {
  expect(adminReports({} as Env)).toEqual({ operations: false, visitors: false });
  expect(adminReports({ OPS_REPORT: 'on', VISITORS: 'on' } as Env)).toEqual({ operations: true, visitors: true });
});

it('reads a queue: the last backlog, the worst wait, and dead letters', () => {
  const account = {
    backlog: [
      { avg: { messages: 9 }, dimensions: { queueId: 'q1' } },
      { avg: { messages: 2 }, dimensions: { queueId: 'q1' } },
      { avg: { messages: 5 }, dimensions: { queueId: 'q2' } },
    ],
    ops: [
      { sum: { billableOperations: 9 }, avg: { lagTime: 900, retryCount: 0 }, dimensions: { queueId: 'q1', actionType: 'WriteMessage', outcome: 'success' } },
      { sum: { billableOperations: 7 }, avg: { lagTime: 120, retryCount: 1 }, dimensions: { queueId: 'q1', actionType: 'ReadMessage', outcome: 'success' } },
      { sum: { billableOperations: 3 }, avg: { lagTime: 400, retryCount: 3 }, dimensions: { queueId: 'q1', actionType: 'ReadMessage', outcome: 'dlq' } },
    ],
  };
  expect(queueRows(account, IDS.queues)).toEqual([
    { label: 'jobs', backlog: 2, wait_ms: 400, retries: 3, dead_lettered: 3, dead_letter_queue: false },
    { label: 'dead-letter', backlog: 5, wait_ms: 0, retries: 0, dead_lettered: 0, dead_letter_queue: true },
  ]);
});

it('reads Workers, the database and storage', () => {
  expect(
    workerRows({
      workers: [
        { sum: { requests: 2 }, quantiles: { cpuTimeP50: 1000 }, dimensions: { scriptName: 'small' } },
        { sum: { requests: 9, errors: 1 }, quantiles: { cpuTimeP99: 8000 }, dimensions: { scriptName: 'big' } },
      ],
    }),
  ).toMatchObject([{ script: 'big', errors: 1, cpu_p99: 8 }, { script: 'small', cpu_p50: 1 }]);
  expect(storageFigures({ r2: [{ max: { payloadSize: 100, objectCount: 1 } }, { max: { payloadSize: 350, objectCount: 4 } }] })).toEqual({
    bytes: 350,
    change_7d: 250,
    objects: 4,
  });
  expect(databaseFigures({ latency: [{ quantiles: { queryBatchTimeMsP90: 12 } }], size: [{ max: { databaseSizeBytes: 5 } }] })).toEqual({
    latency_p50: 0,
    latency_p90: 12,
    bytes: 5,
  });
});

/** The GraphQL API, refusing the query named `broken`. */
function graphql(broken?: string) {
  const asked: string[] = [];
  const fetcher = vi.fn(async (_url: unknown, init: RequestInit) => {
    const { query: text } = JSON.parse(String(init.body));
    const name = /query (\w+)/.exec(text)?.[1] ?? '';
    asked.push(name);
    if (name === broken) return Response.json({ data: null, errors: [{ message: 'unknown field' }] });
    return Response.json({
      data: { viewer: { accounts: [{ backlog: [], ops: [], workers: [], latency: [], size: [], r2: [] }] } },
    });
  });
  return { asked, fetcher: fetcher as unknown as typeof fetch };
}

it('keeps the other sections when one is refused, and ends before now', async () => {
  const { fetcher, asked } = graphql('Database');
  const answer = await infraReport(on, fetcher, NOW);
  expect(asked.sort()).toEqual(['Database', 'Queues', 'Storage', 'Workers']);
  if (!answer.ok) throw new Error('expected a report');
  expect(answer.report.database).toEqual({ ok: false });
  expect(answer.report.queues.ok).toBe(true);
  expect(answer.report.storage.ok).toBe(true);
  expect(Date.parse(answer.report.end)).toBe(NOW - 5 * 60_000);
});

it('holds an answer for a minute', async () => {
  const { fetcher, asked } = graphql();
  await infraReport(on, fetcher, NOW);
  await infraReport(on, fetcher, NOW + 59_000);
  expect(asked).toHaveLength(4);
  await infraReport(on, fetcher, NOW + 61_000);
  expect(asked).toHaveLength(8);
});
