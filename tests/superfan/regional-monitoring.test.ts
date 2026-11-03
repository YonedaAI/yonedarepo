// Regional executions are diagnostics, never extra customer requests. All telemetry is local.
import { afterEach, expect, it, vi } from 'vitest';
import { watchSite } from '../../cloudflare/superfan/config';
import { CloudflareAnalytics } from '../../cloudflare/superfan/analytics';
import { superfanTail } from '../../cloudflare/superfan/index';
import { deadRequests } from '../../cloudflare/superfan/service-points';
import { aggregate } from '../../cloudflare/superfan/tail';
import { ledgerStub, runWatch } from '../../cloudflare/superfan/watch';
import {
  account,
  analytics,
  deps,
  fakeUpstreams,
  feed,
  hour,
  lookup,
  NO_IDS,
  SCRIPT,
  FRONT_URL,
  testEnv,
  traces,
} from './fake-platform';

const start = Date.parse('2026-10-20T15:07:00Z');
const recent = start - 600_000;
const roles = 'api-enam,api-weur,api-apac,api-oc,api-sam,api-afr,platform-weur';
const scripts = roles.split(',').map((role) => `${SCRIPT.replace(/-platform$/, '')}-${role}`);
const monitoring = () =>
  testEnv({ WATCH_WIDE: 'on', WATCH_FRONT_URL: FRONT_URL, WATCH_BACKENDS: roles } as any);
afterEach(() => vi.restoreAllMocks());

it('keeps same-environment alias/EU native failures apart from entry HTTP totals and latency', () => {
  for (const script of ['yonedarepo-dev-platform', 'yonedarepo-prod-platform']) {
    const allowed = scripts.map((s) =>
      s
        .replace('yonedarepo-dev-platform', script)
        .replace('yonedarepo-dev-', script.replace(/-platform$/, '') + '-'),
    );
    const entry = traces(
      { component: 'api_worker', script, count: 20, errors: 1, wallMs: 50 },
      recent,
    );
    const backend = allowed.flatMap((script) =>
      traces(
        { component: 'api_worker', script, count: 4, errors: 1, wallMs: 9000, status: 503 },
        recent,
      ),
    );
    backend[backend.length - 4] = {
      ...backend[backend.length - 4],
      executionModel: 'durableObject',
      entrypoint: 'SourceRepository',
    };
    backend[1].outcome = 'exceededCpu';
    backend[2].logs = [{ level: 'error', message: ['native error'], timestamp: recent }];
    const original = aggregate(entry, script, true).find((r) => r.component === 'api_worker');
    const rows = aggregate([...entry, ...backend], script, true, allowed);
    expect(rows.find((r) => r.component === 'api_worker')).toEqual(original);
    expect(rows.find((r) => r.component === 'backend_execution')).toMatchObject({
      invocations: 28,
      exceptions: 7,
      resourceKills: 1,
      errorLogs: 1,
      errors: 8,
      hist: new Array(28).fill(0),
    });
    expect(aggregate(backend, script, false, allowed)).toEqual([]);
    const foreign = traces(
      {
        component: 'api_worker',
        script: 'yonedarepo-foreign-api-enam',
        count: 1,
        errors: 1,
        wallMs: 50,
      },
      recent,
    );
    expect(aggregate(foreign, script, true, allowed)).toEqual([]);
    // No extra death-point owner is introduced by this diagnostic-only extension.
    expect(deadRequests(backend, script)).toEqual([]);
  }
});

it('raises a native backend finding without adding HTTP-rate or latency signals', async () => {
  vi.spyOn(Date, 'now').mockReturnValue(start);
  fakeUpstreams(analytics());
  const e = testEnv({ ...monitoring(), WATCH_BACKENDS: 'api-apac' });
  const d = deps(e, { now: start });
  d.model = null;
  d.ledger = ledgerStub(e);
  await feed(d.ledger, hour(recent), start, true);
  await superfanTail(
    traces(
      { component: 'api_worker', script: scripts[2], count: 5, errors: 4, wallMs: 10_000 },
      recent,
    ),
    e,
  );
  await runWatch(e, d);
  const native = (await d.ledger.findings('open', 50)).find(
    (f) => f.component === 'backend_execution',
  );
  expect(native).toBeDefined();
  expect(JSON.stringify(native?.signals)).toContain('exceptions');
  expect(JSON.stringify(native?.signals)).not.toMatch(/error_rate|p95_wall_ms/);
  expect(JSON.stringify(native)).not.toContain('abc.def.ghi');
});

it('validates the backend scope before watching unrelated scripts', () => {
  expect(watchSite(monitoring()).backendScripts).toEqual(scripts);
  for (const WATCH_BACKENDS of [
    'yonedarepo-prod-platform',
    'api-unknown',
    'platform',
    'platform-weur,platform-weur',
  ])
    expect(() => watchSite(testEnv({ WATCH_BACKENDS } as any))).toThrow();
});

const eu = {
  repo: 'a'.repeat(32),
  check: 'b'.repeat(32),
  jobs: 'c'.repeat(32),
  dead: 'd'.repeat(32),
  checks: 'e'.repeat(32),
  app: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
};
const regionalLookup = (path: string) => {
  if (path.endsWith(`${SCRIPT}-weur/settings`))
    return Response.json({
      success: true,
      result: {
        bindings: [
          {
            type: 'durable_object_namespace',
            class_name: 'SourceRepository',
            namespace_id: eu.repo,
          },
          {
            type: 'durable_object_namespace',
            class_name: 'CheckContainer',
            namespace_id: eu.check,
          },
        ],
      },
    });
  const value = lookup(path);
  if (!value) return null;
  return value;
};
async function withEu(path: string) {
  const answer = regionalLookup(path);
  if (!answer) return null;
  const body = await answer.json<any>();
  if (path.endsWith('/queues?per_page=100'))
    body.result.push(
      { queue_name: `${SCRIPT}-jobs-weur`, queue_id: eu.jobs },
      { queue_name: `${SCRIPT}-dead-letter-weur`, queue_id: eu.dead },
      { queue_name: `${SCRIPT}-checks-weur`, queue_id: eu.checks },
    );
  if (path.endsWith('/containers/applications'))
    body.result.push({ name: `${SCRIPT}-weur-checkcontainer`, id: eu.app });
  return Response.json(body);
}
const euAccount = () => ({
  objectPeriodic: [{ dimensions: { namespaceId: eu.repo }, sum: { exceededCpuErrors: 2 } }],
  backlog: [
    { dimensions: { queueId: eu.jobs }, avg: { messages: 75 } },
    { dimensions: { queueId: eu.checks }, avg: { messages: 7 } },
    { dimensions: { queueId: eu.dead }, avg: { messages: 3 } },
  ],
  queueOps: [
    {
      dimensions: { queueId: eu.jobs, actionType: 'ReadMessage', outcome: 'dlq' },
      avg: { lagTime: 130_000, retryCount: 2 },
      sum: { billableOperations: 1 },
    },
  ],
  containers: [{ max: { diskUsagePercentage: 91 } }],
});
const graphql = (init?: RequestInit) => {
  const { variables } = JSON.parse(String(init?.body));
  return Response.json({
    data: { viewer: { accounts: [variables.app === eu.app ? euAccount() : account()] } },
  });
};

it('collects EU resources using one extra settings read and GraphQL query, without diluting primary resources', async () => {
  const calls = fakeUpstreams(graphql, (path) => withEu(path) as any);
  const e = testEnv({ ...monitoring(), ...NO_IDS });
  const source = new CloudflareAnalytics(watchSite(e), 'fixture-token');
  const result = await source.collect(start);
  expect(calls.lookups).toHaveLength(4);
  expect(calls.lookups.filter((c) => c.path.includes('/queues'))).toHaveLength(1);
  expect(calls.lookups.filter((c) => c.path.includes('/containers'))).toHaveLength(1);
  expect(calls.graphql).toHaveLength(2);
  expect(result.queue.backlogLatest).toBe(3);
  expect(result.regional?.weur).toMatchObject({
    objectKills: { source_repository: 2 },
    queue: { backlogLatest: 75, deadLetterBacklog: 3 },
    checks: { backlogLatest: 7 },
    containers: { maxDiskPercent: 91 },
  });
});

it('treats missing EU telemetry as configuration failure instead of an empty regional reading', async () => {
  fakeUpstreams(graphql, (path) =>
    path.endsWith(`${SCRIPT}-weur/settings`)
      ? Response.json({ success: false }, { status: 403 })
      : (withEu(path) as any),
  );
  const source = new CloudflareAnalytics(watchSite(monitoring()), 'fixture-token');
  await expect(source.collect(start)).rejects.toThrow(/watch ids|regional|settings/i);
});

it('raises EU resource findings even when primary resources are quiet', async () => {
  fakeUpstreams(graphql, (path) => withEu(path) as any);
  const e = testEnv({ ...monitoring(), ...NO_IDS });
  const d = deps(e, { now: start });
  d.model = null;
  await feed(d.ledger, hour(recent), start, true);
  await runWatch(e, d);
  const findings = await d.ledger.findings('open', 50);
  const regional = findings.find((f) => f.component === 'regional_resources');
  expect(regional).toBeDefined();
  expect(JSON.stringify(regional?.signals)).toContain('dead_letter_backlog');
  expect(JSON.stringify(regional?.signals)).toContain('container_disk_percent');
  expect(
    findings.some((f) => f.component === 'derived_jobs' && f.dedup_key.includes('backlog')),
  ).toBe(false);
});

it('shares authority discovery within one pass and refreshes it after a failed attempt', async () => {
  let refuseEu = true;
  const calls = fakeUpstreams(graphql, (path) =>
    path.endsWith(`${SCRIPT}-weur/settings`) && refuseEu
      ? Response.json({ success: false }, { status: 503 })
      : (withEu(path) as any),
  );
  const source = new CloudflareAnalytics(
    watchSite(testEnv({ ...monitoring(), ...NO_IDS })),
    'fixture-token',
  );
  await expect(Promise.all([source.target(), source.target()])).rejects.toThrow();
  expect(calls.lookups).toHaveLength(4);
  refuseEu = false;
  await Promise.all([source.target(), source.target()]);
  expect(calls.lookups).toHaveLength(8);
  await source.collect(start);
  expect(calls.lookups).toHaveLength(8);
});

it('does not lose backend terminations that carry no exception or response', async () => {
  vi.spyOn(Date, 'now').mockReturnValue(start);
  fakeUpstreams(analytics());
  const e = testEnv({ ...monitoring(), WATCH_BACKENDS: 'api-apac' });
  const d = deps(e, { now: start });
  d.model = null;
  await feed(d.ledger, hour(recent), start, true);
  const events = ['exceededWallTime', 'internalError', 'loadShed'].map((outcome) => ({
    ...traces({ component: 'api_worker', script: scripts[2], count: 1, wallMs: 9000 }, recent)[0],
    outcome,
  }));
  const rows = aggregate(events, SCRIPT, true, scripts);
  expect(rows.find((r) => r.component === 'backend_execution')).toMatchObject({
    errors: 3,
    exceptions: 0,
    marks: { backend_deaths: 3 },
  });
  await d.ledger.ingest(rows, start);
  await runWatch(e, d);
  expect(
    (await d.ledger.findings('open', 50)).some(
      (f) => f.dedup_key === 'backend_execution:backend_deaths',
    ),
  ).toBe(true);
  const benign = ['ok', 'canceled', 'responseStreamDisconnected', 'unknown'].map((outcome) => ({
    ...events[0],
    outcome,
  }));
  expect(aggregate(benign, SCRIPT, true, scripts)[0].marks).toEqual({});
});
