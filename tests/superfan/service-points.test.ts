// What Superfan adds to the service measurements: requests that died, and synthetic results. Fakes
// only: nothing leaves the test.
import { afterEach, describe, expect, it, vi } from 'vitest';
import devSpec from '../../infra/envs/dev.json?raw';
import prodSpec from '../../infra/envs/prod.json?raw';
import type { SuperfanEnv } from '../../cloudflare/superfan/config';
import { superfanTail } from '../../cloudflare/superfan/index';
import { deadRequests } from '../../cloudflare/superfan/service-points';
import { runProbes } from '../../cloudflare/superfan/synthetic';
import { analytics, deps, FRONT_URL, fakeUpstreams, SCRIPT, testEnv, traces } from './fake-platform';

afterEach(() => vi.restoreAllMocks());

const at = Date.parse('2026-10-20T15:07:00Z');
const item = (over: Record<string, unknown>) =>
  ({
    ...traces({ component: 'api_worker', count: 1, wallMs: 300 }, at)[0],
    event: {
      request: { url: 'https://api/api/v1/repos/REDACTED/land', method: 'POST', headers: {} },
    },
    outcome: 'exceededCpu',
    scriptVersion: { id: 'v', tag: 'abc123def456' },
    ...over,
  }) as unknown as TraceItem;

describe('requests that died', () => {
  it('writes a failure the platform never could', () => {
    expect(deadRequests([item({})], SCRIPT)).toEqual([
      {
        indexes: ['died landing'],
        blobs: ['spans', 'died landing', 'abc123def456', '', 'landing', 'failed'],
        doubles: [300, 0, 1],
      },
    ]);
  });

  it.each([
    ['one that answered', { outcome: 'ok' }],
    ['a client that left', { outcome: 'canceled' }],
    ['a stream the client dropped', { outcome: 'responseStreamDisconnected' }],
    ['another Worker', { scriptName: 'yonedarepo-dev-agents' }],
    ['a Durable Object', { executionModel: 'durableObject' }],
    ['a cron', { event: { cron: '* * * * *' } }],
    [
      'a route that is not measured',
      { event: { request: { url: 'https://api/health', method: 'GET', headers: {} } } },
    ],
  ])('leaves out %s', (_what, over) => {
    expect(deadRequests([item(over)], SCRIPT)).toEqual([]);
  });

  it('keeps our own tools apart', () => {
    const own = item({
      event: {
        request: {
          url: 'https://api/api/v1/repos',
          method: 'POST',
          headers: { 'x-yoneda-own-traffic': '1' },
        },
      },
    });
    expect(deadRequests([own], SCRIPT)[0].blobs[3]).toBe('own');
  });

  it('writes from the tail only with the switch on, and survives a failed write', async () => {
    fakeUpstreams(analytics());
    const write = vi.fn();
    const set = { SITE_EVENTS: { writeDataPoint: write } as unknown as AnalyticsEngineDataset };
    await superfanTail([item({})], testEnv(set));
    expect(write).not.toHaveBeenCalled();
    await superfanTail([item({})], testEnv({ ...set, SERVICE_LEVELS: 'on' }));
    expect(write).toHaveBeenCalledTimes(1);
    write.mockImplementation(() => {
      throw new Error('no dataset');
    });
    await expect(
      superfanTail([item({})], testEnv({ ...set, SERVICE_LEVELS: 'on' })),
    ).resolves.toBeUndefined();
  });
});

describe('synthetic results', () => {
  const healthy = (e: SuperfanEnv) => {
    const calls = fakeUpstreams(analytics());
    calls.routes[`${FRONT_URL}/health`] = () =>
      Response.json({ service: 'yonedarepo', revision: 'd'.repeat(40) });
    calls.routes[`${FRONT_URL}/`] = () => new Response('<!doctype html>');
    calls.routes[`${FRONT_URL}/api/v1/explore?limit=1`] = () => Response.json({ repos: [] });
    return deps(e, { now: at });
  };

  it('writes one point per result, and none with the switch off', async () => {
    const points: AnalyticsEngineDataPoint[] = [];
    const base = {
      PROBES: 'on',
      WATCH_FRONT_URL: FRONT_URL,
      SITE_EVENTS: {
        writeDataPoint: (p: AnalyticsEngineDataPoint) => points.push(p),
      } as unknown as AnalyticsEngineDataset,
    };
    const off = testEnv(base);
    await runProbes(off, healthy(off));
    expect(points).toEqual([]);
    const on = testEnv({ ...base, SERVICE_LEVELS: 'on' });
    await runProbes(on, healthy(on));
    expect(points.map((p) => p.blobs?.[1]).sort()).toEqual(['api', 'health', 'page']);
    expect(points[0].blobs?.[0]).toBe('probe');
  });
});

it('is off in both specs, and tracing is off on dev and absent from prod', () => {
  const worker = (text: string, role: string) =>
    JSON.parse(text).workers.find((w: { role: string }) => w.role === role).config;
  for (const text of [devSpec, prodSpec]) {
    expect(worker(text, 'superfan').vars.SERVICE_LEVELS).toBe('off');
    expect(worker(text, 'platform').vars.SERVICE_LEVELS).toBe('off');
    expect(worker(text, 'superfan').analytics_engine_datasets).toEqual(
      worker(text, 'platform').analytics_engine_datasets,
    );
  }
  for (const role of ['platform', 'agents']) {
    expect(worker(devSpec, role).observability.traces.enabled).toBe(false);
    expect(worker(prodSpec, role).observability.traces).toBeUndefined();
  }
});
