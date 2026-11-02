// The Operations, Infrastructure, Visitors and Agents tabs as the server would render them: full, each
// empty, loading and failed state, and that a section that failed leaves the others.
import { createElement, type FunctionComponent } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, expect, it, vi } from 'vitest';

const state: { value: unknown; paths: string[] } = { value: undefined, paths: [] };
vi.mock('../source-platform/useSource', () => ({
  useSource: (path: string) => {
    state.paths.push(path);
    return state.value;
  },
}));

const { AdminInfrastructure, AdminOperations } = await import('./AdminOperations');
const { AdminVisitors } = await import('./AdminVisitors');
const { AdminAgents } = await import('./AdminAgents');

const loaded = (data: unknown) => ({ data, loading: false, reload: () => {} });
const render = (page: FunctionComponent) => renderToStaticMarkup(createElement(page));

beforeEach(() => {
  state.value = { loading: true, reload: () => {} };
  state.paths.length = 0;
});

it.each([
  [AdminOperations, 'Loading operations'],
  [AdminInfrastructure, 'Loading infrastructure'],
  [AdminVisitors, 'Loading visitors'],
  [AdminAgents, 'Loading agents'],
])('says it is loading', (page, words) => expect(render(page)).toContain(words));

it.each([[AdminOperations], [AdminInfrastructure], [AdminVisitors], [AdminAgents]])(
  'offers a way out of a failed read',
  (page) => {
    state.value = { error: 'Nope', loading: false, reload: () => {} };
    expect(render(page)).toContain('role="alert"');
  },
);

it.each([[AdminOperations], [AdminInfrastructure], [AdminVisitors], [AdminAgents]])(
  'says so where it is not set up',
  (page) => {
    state.value = loaded({ ok: false, reason: 'not_configured' });
    expect(render(page)).toContain('set up here');
  },
);

it('names operations and clients in plain words', () => {
  state.value = loaded({
    ok: true,
    range: '7d',
    rows: [
      {
        operation: 'clone',
        client: 'browser',
        count: 4,
        success: 3,
        failed: 1,
        unauthorized: 0,
        rate_limited: 0,
        p50: 120,
        p95: 1500,
        p99: 1500,
        estimated: true,
      },
    ],
  });
  const html = render(AdminOperations);
  for (const words of ['Clone or fetch', 'Browser', '≈4', '120 ms', '1.5 s'])
    expect(html).toContain(words);
  expect(state.paths).toEqual(['/admin/operations?range=7d']);
});

it('says the figures are minutes old, and keeps the sections that could be read', () => {
  state.value = loaded({
    ok: true,
    report: {
      start: '2026-11-01T13:25:00.000Z',
      end: '2026-11-01T14:25:00.000Z',
      queues: {
        ok: true,
        value: [
          {
            label: 'dead-letter',
            backlog: 3,
            wait_ms: 0,
            retries: 0,
            dead_lettered: 0,
            dead_letter_queue: true,
          },
        ],
      },
      workers: { ok: false },
      database: { ok: true, value: { latency_p50: 1, latency_p90: 6, bytes: 1_000_000 } },
      storage: { ok: true, value: { bytes: 2_000_000, change_7d: -1_000_000, objects: 4 } },
    },
  });
  const html = render(AdminInfrastructure);
  expect(html).toContain('minutes old');
  expect(html).toContain('13:25 UTC to 14:25 UTC');
  expect(html).toContain('dead-letter');
  expect(html).toContain('read this');
  expect(html).toContain('1.0 MB held');
  expect(html).toContain('−1.0 MB in 7 days');
});

const report = {
  range: '30d',
  visitors: 0,
  sessions: 0,
  views: 0,
  estimated: false,
  bucket: 'day',
  series: [],
  entries: [],
  exits: [],
  referrers: [],
  countries: [],
  devices: [],
  browsers: [],
  funnel: [
    { step: 'visitors', count: 0, estimated: false },
    { step: 'signups', count: 0, estimated: false },
  ],
  retention: { cohort: 0, returned: 0 },
  campaigns: [],
};

it('says one line with no visitors, and that a day is what is counted', () => {
  state.value = loaded({ ok: true, report });
  const html = render(AdminVisitors);
  expect(html).toContain('No visitors in this range.');
  expect(html).toContain('back the next day counts again');
});

it('shows the way from a visit to a landing, and what sources became', () => {
  state.value = loaded({
    ok: true,
    report: {
      ...report,
      visitors: 10,
      sessions: 12,
      views: 40,
      funnel: [
        { step: 'visitors', count: 10, estimated: false },
        { step: 'signups', count: 2, estimated: false },
      ],
      retention: { cohort: 4, returned: 1 },
      campaigns: [{ key: 'launch', signups: 2, repositories: 1 }],
    },
  });
  const html = render(AdminVisitors);
  for (const words of ['Signed up', '20%', '1 of 4 accounts', 'launch, 1 made a repository'])
    expect(html).toContain(words);
});

const agents = {
  range: '7d',
  credentials: 0,
  sessions: 0,
  repositories: 0,
  organizations: 0,
  concurrency: 0,
  reads: 0,
  writes: 0,
  mcp_calls: 0,
  landings: 0,
  landings_refused: 0,
  landings_failed: 0,
  failures: 0,
  unauthorized: 0,
  rate_limited: 0,
  success_rate: null,
  retry_rate: null,
  estimated: false,
  bucket: 'day',
  series: [],
  clients: [],
};

it('shows the shared empty state with no agents, and no table of zeros', () => {
  state.value = loaded({ ok: true, report: agents });
  const html = render(AdminAgents);
  expect(html).toContain('No agents in this range');
  expect(html).not.toContain('stat-card');
  expect(html).not.toContain('<table');
  expect(state.paths).toEqual(['/admin/agents?range=7d']);
});

it('leads with credentials, labels client names as self-reported, and marks an estimate', () => {
  state.value = loaded({
    ok: true,
    report: {
      ...agents,
      credentials: 12,
      sessions: 40,
      repositories: 7,
      organizations: 2,
      concurrency: 5,
      reads: 900,
      writes: 80,
      mcp_calls: 60,
      landings: 30,
      landings_refused: 8,
      landings_failed: 2,
      failures: 15,
      unauthorized: 3,
      rate_limited: 1,
      success_rate: 0.75,
      retry_rate: 1.25,
      estimated: true,
      series: [
        { start: '2026-11-01T00:00:00.000Z', end: '2026-11-02T00:00:00.000Z', credentials: 3 },
      ],
      clients: [
        { client: 'claude', credentials: 8, requests: 700, landings: 20, estimated: true },
        { client: '', credentials: 4, requests: 40, landings: 0, estimated: true },
      ],
    },
  });
  const html = render(AdminAgents);
  // A credential active on two days is one credential: its bars don't add up to a total.
  expect(html).not.toContain('home-total');
  for (const words of [
    'Active credentials',
    '≈12',
    'Sessions',
    'Repositories reached',
    'Organizations',
    'Reads',
    'Writes',
    'MCP calls',
    'Landings',
    '≈8 refused, ≈2 failed',
    'Failures',
    'Success rate',
    '75%',
    'Retry rate',
    '125%',
    'Peak concurrency',
    'Clients, self-reported',
    'Claude Code',
    'Not named',
  ])
    expect(html).toContain(words);
});
