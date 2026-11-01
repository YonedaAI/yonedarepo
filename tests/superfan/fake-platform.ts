// Test fixture: fake tail events, a fake Cloudflare GraphQL Analytics API, platform /health
// and model endpoint. The GraphQL shape copies a real platform-dev reply (2026-10-20) and
// tail events follow the workers-types TraceItem shape; all numbers are invented. Nothing
// here reaches the network.
import { env } from 'cloudflare:test';
import { vi } from 'vitest';
import { API_URL, GRAPHQL_URL } from '../../cloudflare/superfan/analytics';
import type { SuperfanEnv } from '../../cloudflare/superfan/config';
import type { SuperfanLedger } from '../../cloudflare/superfan/ledger';
import { aggregate, type TailComponent } from '../../cloudflare/superfan/tail';
import { productionDeps, type WatchDeps } from '../../cloudflare/superfan/watch';

export const ANALYTICS_TOKEN = 'fixture-analytics-token-not-real';
export const MODEL_KEY = 'tp-fixture-model-key-not-real';
export const MODEL_URL = 'https://token-plan-sgp.xiaomimimo.com/anthropic/v1/messages';
export const SCRIPT = 'yonedarepo-dev-platform';
export const FRONT_SCRIPT = 'yonedarepo-dev-agents';
export const MANAGED_SCRIPT = 'yonedarepo-dev-agents-managed';
export const FRONT_URL = 'https://dev.yonedarepo.example';
export const SUPERFAN_URL = 'https://yonedarepo-dev-superfan.example.workers.dev';
export const DEADMAN_URL = 'https://yonedarepo-dev-deadman.example.workers.dev';
export const RESEND_URL = 'https://api.resend.com/emails';
export const RESEND_KEY = 're_fixture_key_not_real';
const NS = {
  repo: '11111111111111111111111111111111',
  push: '22222222222222222222222222222222',
  check: '33333333333333333333333333333333',
};
const JOBS = '44444444444444444444444444444444';
const DEAD_LETTER = '55555555555555555555555555555555';
const CHECKS = '77777777777777777777777777777777';
const MANAGED_RUNS = '88888888888888888888888888888888';
const MANAGED_DEAD_LETTER = '99999999999999999999999999999999';
const APP = '66666666-6666-4666-8666-666666666666';
const ACCOUNT = '0123456789abcdef0123456789abcdef';

/** The id variables, unset: the watcher then looks the ids up by name. */
export const NO_IDS = {
  NS_SOURCE_REPOSITORY: undefined,
  NS_OBJECT_PUSH_QUEUE: undefined,
  NS_CHECK_CONTAINER: undefined,
  QUEUE_JOBS_ID: undefined,
  QUEUE_DEAD_LETTER_ID: undefined,
  CHECK_CONTAINER_APP_ID: undefined,
};

/** Cloudflare REST replies naming the watched Worker's resources (the same ids as the config). */
export function lookup(path: string): Response | null {
  const ok = (result: unknown) => Response.json({ success: true, result });
  if (path === `/accounts/${ACCOUNT}/workers/scripts/${SCRIPT}/settings`)
    return ok({
      bindings: [
        { name: 'WORKSPACES', type: 'durable_object_namespace', class_name: 'WorkspaceAuthority', namespace_id: 'f'.repeat(32) },
        { name: 'SOURCE_REPOS', type: 'durable_object_namespace', class_name: 'SourceRepository', namespace_id: NS.repo },
        { name: 'OBJECT_PUSHES', type: 'durable_object_namespace', class_name: 'ObjectPushQueue', namespace_id: NS.push },
        { name: 'CHECK_RUNNERS', type: 'durable_object_namespace', class_name: 'CheckContainer', namespace_id: NS.check },
        { name: 'LAND_MODE', type: 'plain_text', text: 'batch' },
      ],
    });
  if (path === `/accounts/${ACCOUNT}/queues?per_page=100`)
    return ok([
      { queue_name: `${SCRIPT}-jobs`, queue_id: JOBS },
      { queue_name: `${SCRIPT}-checks`, queue_id: CHECKS },
      { queue_name: `${SCRIPT}-dead-letter`, queue_id: DEAD_LETTER },
      { queue_name: 'yonedarepo-dev-managed-runs', queue_id: MANAGED_RUNS },
      { queue_name: 'yonedarepo-dev-managed-dead-letter', queue_id: MANAGED_DEAD_LETTER },
    ]);
  if (path === `/accounts/${ACCOUNT}/containers/applications`)
    return ok([{ name: `${SCRIPT}-checkcontainer`, id: APP }]);
  return null;
}

export interface Traffic {
  backlog?: [number, number];
  repoKills?: number;
  checksBacklog?: [number, number];
  managedBacklog?: [number, number];
  /** Messages moved to a dead letter queue this hour, per source queue. */
  deadLettered?: { jobs?: number; checks?: number; managed?: number };
  /** Messages waiting in a dead letter queue. */
  deadBacklog?: { platform?: number; managed?: number };
}

const backlogRows = (queueId: string, values: number[]) =>
  values.map((messages, i) => ({
    avg: { messages },
    dimensions: { queueId, datetimeFiveMinutes: `2026-10-20T14:${30 + 5 * i}:00Z` },
  }));
const deadRow = (queueId: string, billableOperations: number) => ({
  avg: { lagTime: 0, retryCount: 1 },
  dimensions: { queueId, actionType: 'DeleteMessage', outcome: 'dlq' },
  sum: { billableOperations },
});

/** One GraphQL account result; defaults describe a quiet hour. */
export function account(t: Traffic = {}) {
  return {
    objectPeriodic: Object.values(NS).map((namespaceId) => ({
      dimensions: { namespaceId },
      sum: {
        exceededCpuErrors: namespaceId === NS.repo ? (t.repoKills ?? 0) : 0,
        exceededMemoryErrors: 0,
        fatalInternalErrors: 0,
      },
    })),
    backlog: [
      ...backlogRows(JOBS, t.backlog ?? [2, 3]),
      ...backlogRows(CHECKS, t.checksBacklog ?? [0, 1]),
      ...backlogRows(MANAGED_RUNS, t.managedBacklog ?? [0, 0]),
      ...backlogRows(DEAD_LETTER, [t.deadBacklog?.platform ?? 0]),
      ...backlogRows(MANAGED_DEAD_LETTER, [t.deadBacklog?.managed ?? 0]),
    ],
    queueOps: [
      {
        avg: { lagTime: 3000, retryCount: 0 },
        dimensions: { queueId: JOBS, actionType: 'ReadMessage', outcome: '' },
        sum: { billableOperations: 50 },
      },
      {
        avg: { lagTime: 0, retryCount: 0 },
        dimensions: { queueId: JOBS, actionType: 'WriteMessage', outcome: '' },
        sum: { billableOperations: 50 },
      },
      ...(t.deadLettered?.jobs ? [deadRow(JOBS, t.deadLettered.jobs)] : []),
      ...(t.deadLettered?.checks ? [deadRow(CHECKS, t.deadLettered.checks)] : []),
      ...(t.deadLettered?.managed ? [deadRow(MANAGED_RUNS, t.deadLettered.managed)] : []),
    ],
    containers: [{ max: { diskUsagePercentage: 12 } }],
  };
}

const CLASSES: Partial<Record<TailComponent, string>> = {
  source_repository: 'SourceRepository',
  object_push_queue: 'ObjectPushQueue',
  check_runs: 'CheckContainer',
  land_queue: 'LandCombiner',
  commit_shards: 'CommitShard',
  pack_builder: 'PackBuilder',
  ssh_gateway: 'SshGateway',
  workspace_authority: 'WorkspaceAuthority',
};

export interface Calls {
  component: TailComponent;
  count: number;
  wallMs: number;
  errors?: number;
  logs?: { level: string; message: unknown[] }[];
  script?: string;
  /** Durable Object class, where it is not the component's own. */
  object?: string;
  status?: number;
}

/** TraceItem-shaped events: `errors` of them threw, all took `wallMs`. */
export function traces(c: Calls, at: number): TraceItem[] {
  const object = c.object ?? CLASSES[c.component];
  const event =
    c.component === 'api_worker' || c.component === 'front_worker'
      ? {
          request: { url: 'https://platform/api/v1/x', method: 'GET', headers: {} },
          response: { status: c.status ?? 200 },
        }
      : c.component === 'derived_jobs'
        ? { queue: 'yonedarepo-dev-platform-jobs', batchSize: 1 }
        : c.component === 'cron'
          ? { cron: '* * * * *', scheduledTime: at }
          : { rpcMethod: 'fetch' };
  return Array.from({ length: c.count }, (_, i) => {
    const thrown = i < (c.errors ?? 0);
    return {
      event,
      eventTimestamp: at,
      logs: (c.logs ?? []).map((l) => ({ ...l, timestamp: at })),
      exceptions: thrown
        ? [{ name: 'Error', message: 'commit failed: Bearer abc.def.ghi rejected', timestamp: at }]
        : [],
      diagnosticsChannelEvents: [],
      scriptName: c.script ?? SCRIPT,
      ...(object ? { entrypoint: object } : c.component === 'cron' ? { entrypoint: 'default' } : {}),
      outcome: thrown ? 'exception' : 'ok',
      executionModel: object ? 'durableObject' : 'stateless',
      truncated: false,
      cpuTime: 2,
      wallTime: c.wallMs,
    } as unknown as TraceItem;
  });
}

/** A quiet hour of platform traffic, with optional per-component overrides. */
export function hour(at: number, overrides: Partial<Record<TailComponent, Partial<Calls>>> = {}) {
  const base: Calls[] = [
    { component: 'api_worker', count: 100, wallMs: 50 },
    { component: 'source_repository', count: 200, wallMs: 80 },
    { component: 'object_push_queue', count: 50, wallMs: 700 },
    { component: 'check_runs', count: 20, wallMs: 9000 },
    { component: 'derived_jobs', count: 30, wallMs: 300 },
  ];
  return base.flatMap((c) => traces({ ...c, ...overrides[c.component] }, at));
}

/** What the tail handler stores for these events. */
export const feed = (
  ledger: DurableObjectStub<SuperfanLedger>,
  events: TraceItem[],
  now: number,
  wide = false,
) => ledger.ingest(aggregate(events, SCRIPT, wide), now);

/** One log line of a named event, as `traces` carries it. */
export const logLine = (event: string, level = 'log', fields: Record<string, unknown> = {}) => ({
  level,
  message: [JSON.stringify({ event, ...fields })],
});

export interface FakeCalls {
  graphql: RequestInit[];
  lookups: { path: string; headers: Headers }[];
  model: { url: string; headers: Headers; body: Record<string, any> }[];
  mail: { headers: Headers; body: Record<string, any> }[];
  /** Resend's answer; a fixture can make it fail. */
  mailAnswer: () => Response;
  /** A URL's answer, set by a test; health endpoints default to healthy. */
  routes: Record<string, () => Response>;
}

/** Routes fetch to the fakes; `graphql` decides the analytics reply per call. */
export function fakeUpstreams(
  graphql: () => Response | Promise<Response>,
  rest: (path: string) => Response | null = lookup,
): FakeCalls {
  const calls: FakeCalls = {
    graphql: [],
    lookups: [],
    model: [],
    mail: [],
    mailAnswer: () => Response.json({ id: 'fixture-email' }),
    routes: {
      [`${FRONT_URL}/health`]: () => Response.json({ service: 'yonedarepo', v: 1 }),
    },
  };
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url === GRAPHQL_URL) {
      calls.graphql.push(init ?? {});
      return graphql();
    }
    const route = calls.routes[url];
    if (route) return route();
    if (url === 'https://yonedarepo-dev-platform.example.workers.dev/health')
      return Response.json({ service: 'yonedarepo-platform', v: 1, revision: 'fixture' });
    if (url === RESEND_URL) {
      calls.mail.push({
        headers: new Headers(init?.headers),
        body: JSON.parse(String(init?.body)),
      });
      return calls.mailAnswer();
    }
    if (url === MODEL_URL) {
      calls.model.push({
        url,
        headers: new Headers(init?.headers),
        body: JSON.parse(String(init?.body)),
      });
      return Response.json({
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              title: 'SourceRepository errors at 10%',
              what: 'Commit/land calls fail far above the 2% rule.',
              evidence: 'error_rate=0.1 over 900 requests',
              likely_cause: 'unknown',
              next_check: 'Group SourceRepository errors by status in Workers Logs.',
            }),
          },
        ],
        usage: { input_tokens: 900, output_tokens: 120 },
      });
    }
    if (url.startsWith(`${API_URL}/accounts/`) && !url.endsWith('/tokens/verify')) {
      const path = url.slice(API_URL.length);
      calls.lookups.push({ path, headers: new Headers(init?.headers) });
      const reply = rest(path);
      if (reply) return reply;
    }
    if (url.endsWith('/tokens/verify'))
      return Response.json(
        { success: false, errors: [{ message: 'Invalid API Token' }] },
        { status: 400 },
      );
    throw new Error(`Unexpected fetch in superfan test: ${url}`);
  });
  return calls;
}

export const analytics =
  (t: Traffic = {}) =>
  () =>
    Response.json({ data: { viewer: { accounts: [account(t)] } }, errors: null });

/** Test env: real ledger binding, fixture secrets, optional overrides. */
export function testEnv(overrides: Partial<SuperfanEnv> = {}): SuperfanEnv {
  return {
    ...(env as unknown as SuperfanEnv),
    CF_ANALYTICS_TOKEN: ANALYTICS_TOKEN,
    SUPERFAN_READ_TOKEN: 'fixture-read-token',
    MIMO_KEY: { get: async () => MODEL_KEY } as SecretsStoreSecret,
    ...overrides,
  };
}

/** Production wiring against a fresh ledger and a controllable clock. */
export function deps(e: SuperfanEnv, clock: { now: number }): WatchDeps {
  return {
    ...productionDeps(e),
    ledger: e.LEDGER.get(e.LEDGER.idFromName(crypto.randomUUID())),
    now: () => clock.now,
    pause: async () => {},
  };
}
