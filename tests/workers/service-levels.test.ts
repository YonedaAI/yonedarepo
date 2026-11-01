// What's measured for service targets, the point each request writes, and the report read back.
// Budget and definitions: docs/observability-plan.md.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { served } from '../../cloudflare/worker/log';
import { platformFetch } from '../../cloudflare/worker/platform-routes';
import { serviceLevels, serviceQueries } from '../../cloudflare/worker/platform-service-levels';
import { inScope } from '../../cloudflare/worker/request-scope';
import { sampleSpans } from '../../cloudflare/worker/repo-span-sample';
import type { Env } from '../../cloudflare/worker/types';
import {
  requestPoint,
  serviceClass,
  serviceOperation,
} from '../../shared/service-levels';
import { api, author, file, scoped, signup, usePlatformFixture } from './repo-fixture';

usePlatformFixture();
afterEach(() => vi.restoreAllMocks());

type Point = { blobs: string[]; doubles: number[]; indexes: string[] };

function measuring(over: Partial<Env> = {}) {
  const points: Point[] = [];
  const env = {
    ...scoped,
    BUILD_REVISION: 'a'.repeat(40),
    SERVICE_LEVELS: 'on',
    TRAFFIC_EVENTS: 'off',
    SITE_EVENTS: { writeDataPoint: (p: Point) => points.push(p) },
    ...over,
  } as unknown as Env;
  const waits: Promise<unknown>[] = [];
  return { env, points, waitUntil: (w: Promise<unknown>) => waits.push(w), settle: () => Promise.all(waits) };
}
const table = (ms = 40) => new Map([['total', { ms, n: 1 }]]);
const request = (path: string, method = 'GET', headers = {}) =>
  new Request(`https://yoneda${path}`, { method, headers });

async function sample(path: string, method = 'GET', status = 200, random = () => 0, over = {}) {
  const s = measuring(over);
  const req = request(path, method);
  await inScope({ env: s.env, req, waitUntil: s.waitUntil }, async () =>
    sampleSpans(s.env, req, table(), status, random),
  );
  await s.settle();
  return s.points;
}

describe('what counts', () => {
  it.each([
    ['GET', '/api/v1/repos/r0123456789abcdef0123/log', 'api_read'],
    ['HEAD', '/api/v1/repos', 'api_read'],
    ['GET', '/api/v1/admin/signups', null],
    ['POST', '/api/v1/repos/r0123456789abcdef0123/land', 'landing'],
    ['POST', '/api/v1/repos/REDACTED/land', 'landing'],
    ['POST', '/api/v1/repos', 'repo_create'],
    ['POST', '/api/v1/repos/r0123456789abcdef0123/commits', null],
    ['POST', '/git/r0123456789abcdef0123.git/git-upload-pack', 'git_clone'],
    ['POST', '/some-handle/some-name.git/git-upload-pack', 'git_clone'],
    ['POST', '/git/REDACTED.git/git-receive-pack', 'git_push'],
    ['GET', '/git/r0123456789abcdef0123.git/info/refs', null],
    ['GET', '/health', null],
    ['DELETE', '/api/v1/repos/r0123456789abcdef0123', null],
  ])('%s %s is %s', (method, path, operation) => {
    expect(serviceOperation(method, path)).toBe(operation);
  });

  it.each([
    [200, 'ok'],
    [302, 'ok'],
    [404, 'refused'],
    [409, 'refused'],
    [429, 'refused'],
    [500, 'failed'],
    [503, 'failed'],
    [0, 'failed'],
  ])('status %i is %s', (status, name) => {
    expect(serviceClass(status)).toBe(name);
  });
});

describe('the point', () => {
  it('writes nothing with the switch off, and spends no draw', async () => {
    const random = vi.fn(() => 0);
    const points = await sample('/api/v1/repos', 'POST', 200, random, { SERVICE_LEVELS: undefined });
    expect(points).toEqual([]);
    expect(random).not.toHaveBeenCalled();
  });

  it('writes nothing for a request it does not measure, and spends no draw', async () => {
    const random = vi.fn(() => 0);
    expect(await sample('/health', 'GET', 200, random)).toEqual([]);
    expect(random).not.toHaveBeenCalled();
  });

  it('keeps every landing, and no log line', async () => {
    const info = vi.spyOn(console, 'log').mockImplementation(() => {});
    const [point] = await sample('/api/v1/repos/r0123456789abcdef0123/land', 'POST', 200, () => 0.99);
    expect(point.blobs.slice(0, 6)).toEqual([
      'spans',
      'POST /api/v1/repos/:repo/land',
      'a'.repeat(12),
      '',
      'landing',
      'ok',
    ]);
    expect(point.doubles).toEqual([40, 200, 1]);
    expect(JSON.stringify(point)).not.toContain('r0123456789abcdef0123');
    expect(info).not.toHaveBeenCalled();
  });

  it('keeps 1 read in 10, weighted to stand for 10', async () => {
    const path = '/api/v1/repos/r0123456789abcdef0123/log';
    expect(await sample(path, 'GET', 200, () => 0.1)).toEqual([]);
    const [point] = await sample(path, 'GET', 200, () => 0.09);
    expect(point.doubles).toEqual([40, 200, 10]);
  });

  it('is one point when spans pick the same request, with the line as well', async () => {
    const info = vi.spyOn(console, 'log').mockImplementation(() => {});
    const points = await sample('/api/v1/repos', 'POST', 201, () => 0, { SPAN_SAMPLE: '1' });
    expect(points).toHaveLength(1);
    expect(points[0].blobs[4]).toBe('repo_create');
    expect(info).toHaveBeenCalledTimes(1);
  });

  it('counts for nothing when only spans picked it', async () => {
    const points = await sample('/api/v1/repos/r0123456789abcdef0123/log', 'GET', 200, () => 0.5, {
      SPAN_SAMPLE: '1',
    });
    expect(points).toHaveLength(1);
    expect(points[0].blobs[4]).toBe('api_read');
    expect(points[0].doubles[2]).toBe(0);
  });

  it('names what became of a request', async () => {
    const land = '/api/v1/repos/r0123456789abcdef0123/land';
    expect((await sample(land, 'POST', 409))[0].blobs[5]).toBe('refused');
    expect((await sample(land, 'POST', 503))[0].blobs[5]).toBe('failed');
  });

  it('marks our own tools', async () => {
    const s = measuring();
    const req = request('/api/v1/repos', 'POST', { 'x-yoneda-own-traffic': '1' });
    await inScope({ env: s.env, req, waitUntil: s.waitUntil }, async () =>
      sampleSpans(s.env, req, table(), 200, () => 0),
    );
    await s.settle();
    expect(s.points[0].blobs[3]).toBe('own');
  });

  it('stays inside what a point may hold', () => {
    const spans = Array.from({ length: 40 }, (_, i) => ({ name: `s${i}`, ms: i }));
    const point = requestPoint({
      name: 'x'.repeat(200),
      revision: 'a'.repeat(40),
      own: false,
      operation: 'landing',
      status: 200,
      totalMs: 1,
      weight: 1,
      spans,
    });
    expect(point.blobs.length).toBeLessThanOrEqual(20);
    expect(point.doubles.length).toBeLessThanOrEqual(20);
    expect(point.indexes[0].length).toBeLessThanOrEqual(96);
  });

  it('measures a real landing, a real create and a real clone through the platform', async () => {
    const cookie = await signup('service_owner');
    const s = measuring();
    const send = (path: string, init?: RequestInit) => {
      const req = new Request(`https://yoneda${path}`, init);
      return served({ env: s.env, req, waitUntil: s.waitUntil }, () => platformFetch(req, s.env));
    };
    const body = {
      name: 'measured',
      visibility: 'public',
      policy: { approvals: 0, required_checks: [] },
      files: [file('a.md', 'a\n')],
      author,
    };
    const created = await send('/api/v1/repos', {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    expect(created.status).toBe(200);
    const { id } = await created.json<{ id: string }>();
    const made = await api(`/repos/${id}/commits`, { cookie }, {
      body: { ref: 'main', changes: [file('b.md', 'b\n')], message: 'b', author },
    });
    const landed = await send(`/api/v1/repos/${id}/land`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ ref: 'main', commit: made.body.commit }),
    });
    expect(landed.status).toBe(200);
    const main = (await api(`/repos/${id}/refs`, { cookie })).body.refs['refs/heads/main'];
    const clone = await send(`/git/${id}.git/git-upload-pack`, {
      method: 'POST',
      body: `0032want ${main}\n00000009done\n`,
    });
    await clone.arrayBuffer();
    await s.settle();
    expect(s.points.map((p) => p.blobs[4])).toEqual(['repo_create', 'landing', 'git_clone']);
    for (const p of s.points) expect(p.blobs[5]).toBe('ok');
  });
});

describe('the report', () => {
  const now = Date.parse('2026-11-20T12:00:00Z');
  const reader = (answers: Record<string, unknown[]>) => {
    const seen: string[] = [];
    const fetcher = (async (_url: string, init: RequestInit) => {
      const sql = String(init.body);
      seen.push(sql);
      const name = sql.includes("'probe'") ? 'probes' : sql.includes('p99') ? 'latency' : 'counts';
      return Response.json({ data: answers[name] ?? [] });
    }) as unknown as typeof fetch;
    return { fetcher, seen };
  };
  const on = {
    SERVICE_LEVELS: 'on',
    CF_ACCOUNT_ID: 'a'.repeat(32),
    SITE_EVENTS_DATASET: 'events',
    ANALYTICS_READ_TOKEN: 'token',
  } as unknown as Env;

  it('is off and unconfigured in its own words, with no statement', async () => {
    const { fetcher, seen } = reader({});
    expect(await serviceLevels({} as Env, fetcher, now)).toEqual({ ok: false, reason: 'off' });
    expect(await serviceLevels({ SERVICE_LEVELS: 'on' } as Env, fetcher, now)).toEqual({
      ok: false,
      reason: 'not_configured',
    });
    expect(seen).toEqual([]);
  });

  it('spends three statements, and reads only what it wrote', async () => {
    const { fetcher, seen } = reader({});
    await serviceLevels(on, fetcher, now);
    expect(seen).toHaveLength(3);
    for (const sql of seen) expect(sql).toMatch(/blob1 = '(spans|probe)'/);
    const { latency } = serviceQueries('events', now);
    expect(latency).toContain("blob6 = 'ok'");
    expect(latency).toContain('double3 > 0');
  });

  it('adds up each operation, apart from our tools, and leaves refusals out of the rate', async () => {
    const row = (operation: string, own: string, name: string, count: number, sampling = 1) => ({
      operation,
      own,
      class: name,
      count,
      sampling,
      since: '2026-11-08 12:00:00',
    });
    const { fetcher } = reader({
      counts: [
        row('landing', '', 'ok', 90),
        row('landing', '', 'refused', 50),
        row('landing', '', 'failed', 10),
        row('git_push', 'own', 'ok', 5),
        row('api_read', '', 'ok', 1000),
      ],
      latency: [{ operation: 'landing', own: '', p50: 10, p95: 20, p99: 30 }],
      probes: [
        { name: 'clone', class: 'ok', count: 9, p50: 400, p95: 800 },
        { name: 'clone', class: 'failed', count: 1, p50: 15000, p95: 15000 },
      ],
    });
    const answer = await serviceLevels(on, fetcher, now);
    if (!answer.ok) throw new Error(answer.reason);
    const { report } = answer;
    expect(report.days_measured).toBe(12);
    expect(report.people.map((r) => r.operation)).toEqual([
      'api_read',
      'landing',
      'git_clone',
      'git_push',
      'repo_create',
    ]);
    expect(report.people[1]).toEqual({
      operation: 'landing',
      requests: 150,
      failed: 10,
      failure_rate: 0.1,
      latency: { p50: 10, p95: 20, p99: 30 },
      estimated: false,
    });
    expect(report.people[0]).toMatchObject({ requests: 1000, estimated: true, latency: null });
    expect(report.people[3].requests).toBe(0);
    expect(report.ours[3].requests).toBe(5);
    expect(report.outside).toEqual([
      { check: 'clone', runs: 10, failed: 1, latency: { p50: 400, p95: 800 } },
    ]);
  });

  it('stops counting days at 30, and has none with no data', async () => {
    const old = [{ operation: 'landing', own: '', class: 'ok', count: 1, sampling: 1, since: '2026-01-01 00:00:00' }];
    const answer = await serviceLevels(on, reader({ counts: old }).fetcher, now);
    expect(answer).toMatchObject({ ok: true, report: { days_measured: 30 } });
    const none = await serviceLevels(on, reader({}).fetcher, now);
    expect(none).toMatchObject({ ok: true, report: { days_measured: 0 } });
  });

  it('says so when a query fails', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const fetcher = (async () => new Response('no', { status: 503 })) as unknown as typeof fetch;
    expect(await serviceLevels(on, fetcher, now)).toEqual({ ok: false, reason: 'query_failed' });
  });
});
