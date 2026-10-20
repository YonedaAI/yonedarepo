// Test fixture: a fake Cloudflare GraphQL Analytics API, platform /health and model
// endpoint. The response shape copies a real platform-dev reply (2026-10-20); the numbers
// are invented. Nothing here reaches the network.
import { env } from 'cloudflare:test';
import { vi } from 'vitest';
import type { SuperfanEnv } from '../../cloudflare/superfan/config';
import { GRAPHQL_URL } from '../../cloudflare/superfan/telemetry';
import { productionDeps, type WatchDeps } from '../../cloudflare/superfan/watch';

export const ANALYTICS_TOKEN = 'fixture-analytics-token-not-real';
export const MODEL_KEY = 'tp-fixture-model-key-not-real';
export const MODEL_URL = 'https://token-plan-sgp.xiaomimimo.com/anthropic/v1/messages';
const NS = {
  repo: '11111111111111111111111111111111',
  push: '22222222222222222222222222222222',
  check: '33333333333333333333333333333333',
};
const JOBS = '44444444444444444444444444444444';

export interface Traffic {
  repoRequests?: number;
  repoErrors?: number;
  repoP95Ms?: number;
  backlog?: [number, number];
  workerErrors?: number;
}

/** One GraphQL account result; defaults describe a quiet hour. */
export function account(t: Traffic = {}) {
  const object = (namespaceId: string, requests: number, errors: number, p95Ms: number) => ({
    dimensions: { namespaceId },
    quantiles: { wallTimeP95: p95Ms * 1000 },
    sum: { requests, errors },
  });
  return {
    workerAll: [
      {
        quantiles: { cpuTimeP95: 20_000, wallTimeP95: 400_000 },
        sum: { requests: 1000, errors: t.workerErrors ?? 0 },
      },
    ],
    workerStatus: [{ dimensions: { status: 'success' }, sum: { requests: 1000 } }],
    objectAll: [
      object(NS.repo, t.repoRequests ?? 900, t.repoErrors ?? 0, t.repoP95Ms ?? 80),
      object(NS.push, 200, 0, 700),
      object(NS.check, 100, 0, 9000),
    ],
    objectStatus: [
      { dimensions: { namespaceId: NS.repo, status: 'success' }, sum: { requests: 900 } },
    ],
    objectPeriodic: Object.values(NS).map((namespaceId) => ({
      dimensions: { namespaceId },
      sum: { exceededCpuErrors: 0, exceededMemoryErrors: 0, fatalInternalErrors: 0 },
    })),
    backlog: (t.backlog ?? [2, 3]).map((messages, i) => ({
      avg: { messages },
      dimensions: { queueId: JOBS, datetimeFiveMinutes: `2026-10-20T14:${30 + 5 * i}:00Z` },
    })),
    queueOps: [
      {
        avg: { lagTime: 3000, retryCount: 0 },
        dimensions: { actionType: 'ReadMessage', outcome: '' },
        sum: { billableOperations: 50 },
      },
      {
        avg: { lagTime: 0, retryCount: 0 },
        dimensions: { actionType: 'WriteMessage', outcome: '' },
        sum: { billableOperations: 50 },
      },
    ],
    containers: [{ max: { diskUsagePercentage: 12 } }],
  };
}

export interface FakeCalls {
  graphql: RequestInit[];
  model: { url: string; headers: Headers; body: Record<string, any> }[];
}

/** Routes fetch to the fakes; `graphql` decides the analytics reply per call. */
export function fakeUpstreams(graphql: () => Response | Promise<Response>): FakeCalls {
  const calls: FakeCalls = { graphql: [], model: [] };
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url === GRAPHQL_URL) {
      calls.graphql.push(init ?? {});
      return graphql();
    }
    if (url === 'https://yonedarepo-platform-dev.example.workers.dev/health')
      return Response.json({ service: 'yonedarepo-platform', v: 1, revision: 'fixture' });
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
  };
}
