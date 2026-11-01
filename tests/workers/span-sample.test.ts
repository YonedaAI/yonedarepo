// Sampling Server-Timing into a log line and one Analytics Engine point (SPAN_SAMPLE). Budget:
// docs/observability-plan.md.
import { afterEach, expect, it, vi } from 'vitest';
import { served } from '../../cloudflare/worker/log';
import { trafficQueries, trafficSpan } from '../../cloudflare/worker/platform-traffic-queries';
import { inScope } from '../../cloudflare/worker/request-scope';
import { platformFetch } from '../../cloudflare/worker/platform-routes';
import { record, withTimings } from '../../cloudflare/worker/repo-timing';
import { sampleSpans } from '../../cloudflare/worker/span-sample';
import type { Env } from '../../cloudflare/worker/types';
import { api, author, file, scoped, signup, usePlatformFixture } from './repo-fixture';

usePlatformFixture();
afterEach(() => vi.restoreAllMocks());

type Point = AnalyticsEngineDataPoint & { blobs: string[]; doubles: number[]; indexes: string[] };

function sampling(setting: string | undefined, over: Partial<Env> = {}) {
  const points: Point[] = [];
  const env = {
    ...scoped,
    BUILD_REVISION: 'a'.repeat(40),
    SPAN_SAMPLE: setting,
    TRAFFIC_EVENTS: 'off',
    SITE_EVENTS: { writeDataPoint: (p: Point) => points.push(p) },
    ...over,
  } as unknown as Env;
  const waits: Promise<unknown>[] = [];
  const waitUntil = (work: Promise<unknown>) => waits.push(work);
  return { env, points, waitUntil, settle: () => Promise.all(waits) };
}

const lines = () => {
  const info = vi.spyOn(console, 'log').mockImplementation(() => {});
  return () =>
    info.mock.calls
      .map(([text]) => JSON.parse(String(text)))
      .filter((l: { event: string }) => l.event === 'request.spans');
};
const health = (headers = {}) => new Request('https://yoneda/api/v1/search', { headers });
const phases = (entries: [string, number][]) =>
  new Map(entries.map(([name, ms]) => [name, { ms, n: 1 }]));

/** Runs one sampler call in a request's scope. */
async function sample(
  setting: string | undefined,
  table: ReturnType<typeof phases>,
  random = () => 0,
  over: Partial<Env> = {},
) {
  const s = sampling(setting, over);
  await inScope({ env: s.env, req: health(), waitUntil: s.waitUntil }, async () =>
    sampleSpans(s.env, health(), table, 200, random),
  );
  await s.settle();
  return s;
}

it.each([undefined, 'off', '', '0', '-1', '2.5', 'often'])('does nothing at %s', async (setting) => {
  const read = lines();
  const random = vi.fn(() => 0);
  const { points } = await sample(setting, phases([['total', 9_000]]), random);
  expect(points).toEqual([]);
  expect(read()).toEqual([]);
  expect(random).not.toHaveBeenCalled();
});

it('picks one request in N', async () => {
  const table = phases([['total', 10]]);
  expect((await sample('4', table, () => 0.24)).points).toHaveLength(1);
  expect((await sample('4', table, () => 0.25)).points).toEqual([]);
});

it('keeps every slow request, whatever the draw', async () => {
  const { points } = await sample('1000', phases([['total', 5_000]]), () => 0.99);
  expect(points).toHaveLength(1);
});

it('names the spans, slowest first, under the operation, with its id in the log alone', async () => {
  const read = lines();
  const table = phases([
    ['auth', 3],
    ['total', 40.26],
    ['hop.r2', 30],
  ]);
  const s = sampling('1');
  const req = new Request('https://yoneda/api/v1/repos/r0123456789abcdef0123/files/a.md', {
    headers: { 'cf-ray': '8f1c2d3e4a5b6c7d-SJC' },
  });
  await inScope({ env: s.env, req, waitUntil: s.waitUntil }, async () =>
    sampleSpans(s.env, req, table, 200, () => 0),
  );
  await s.settle();
  const [point] = s.points;
  const operation = 'GET /api/v1/repos/:repo/files';
  expect(point.indexes).toEqual([operation]);
  expect(point.blobs).toEqual(['spans', operation, 'a'.repeat(12), '', 'hop.r2', 'auth']);
  expect(point.doubles).toEqual([40.3, 200, 30, 3]);
  const text = JSON.stringify(point);
  expect(text).not.toContain('r0123456789abcdef0123');
  expect(text).not.toContain('8f1c2d3e4a5b6c7d');
  expect(read()).toMatchObject([
    {
      request_id: '8f1c2d3e4a5b6c7d-SJC',
      repo: 'r0123456789abcdef0123',
      operation,
      status: 200,
      total_ms: 40.3,
      spans: [
        { name: 'hop.r2', ms: 30, count: 1 },
        { name: 'auth', ms: 3, count: 1 },
      ],
    },
  ]);
});

it('marks our own traffic, so a reader can leave it out', async () => {
  const s = sampling('1');
  const req = health({ 'x-yoneda-own-traffic': '1' });
  await inScope({ env: s.env, req, waitUntil: s.waitUntil }, async () =>
    sampleSpans(s.env, req, phases([['total', 1]]), 200, () => 0),
  );
  await s.settle();
  expect(s.points[0].blobs[3]).toBe('own');
});

it('writes at most one point a request, however many timed scopes it held', async () => {
  const s = sampling('1');
  await inScope({ env: s.env, req: health(), waitUntil: s.waitUntil }, async () => {
    sampleSpans(s.env, health(), phases([['total', 1]]), 200, () => 0);
    sampleSpans(s.env, health(), phases([['total', 2]]), 200, () => 0);
  });
  await s.settle();
  expect(s.points).toHaveLength(1);
});

it('stays inside what a point and a line may hold', async () => {
  const read = lines();
  const many = Array.from({ length: 40 }, (_, i) => [`span.${i}`, i] as [string, number]);
  const { points } = await sample('1', phases([['total', 100], ...many]));
  const [point] = points;
  expect(point.blobs.length).toBeLessThanOrEqual(20);
  expect(point.doubles.length).toBeLessThanOrEqual(20);
  expect(new TextEncoder().encode(point.indexes[0]).length).toBeLessThanOrEqual(96);
  expect(point.blobs.slice(4, 6)).toEqual(['span.39', 'span.38']);
  const [line] = read();
  expect(line.spans).toHaveLength(20);
});

it('writes after the answer, and only while a request lends its waitUntil', async () => {
  const s = sampling('1');
  await inScope({ env: s.env, req: health(), waitUntil: s.waitUntil }, async () =>
    sampleSpans(s.env, health(), phases([['total', 1]]), 200, () => 0),
  );
  expect(s.points).toEqual([]);
  await s.settle();
  expect(s.points).toHaveLength(1);

  const lent = sampling('1');
  await inScope({ env: lent.env, req: health() }, async () =>
    sampleSpans(lent.env, health(), phases([['total', 1]]), 200, () => 0),
  );
  await new Promise((done) => setTimeout(done, 5));
  expect(lent.points).toEqual([]);
});

it('cannot fail a request', async () => {
  const s = sampling('1', {
    SITE_EVENTS: {
      writeDataPoint: () => {
        throw new Error('no dataset');
      },
    } as unknown as AnalyticsEngineDataset,
  });
  await inScope({ env: s.env, req: health(), waitUntil: s.waitUntil }, async () => {
    expect(() =>
      sampleSpans(s.env, health(), phases([['total', 1]]), 200, () => 0),
    ).not.toThrow();
  });
  await expect(s.settle()).resolves.toBeDefined();
  const { env } = sampling('1', { SITE_EVENTS: undefined });
  await inScope({ env, req: health(), waitUntil: () => {} }, async () =>
    expect(() => sampleSpans(env, health(), phases([['total', 1]]), 200)).not.toThrow(),
  );
});

it('sees through withTimings', async () => {
  const { phases: kept } = await withTimings(async () => {
    record('step', 2);
    return 1;
  });
  expect([...kept.keys()].sort()).toEqual(['step', 'total']);
});

it('samples a real API read and a real clone, each under its own operation', async () => {
  const cookie = await signup('span_owner');
  const created = await api('/repos', { cookie }, {
    body: { name: 'spans', visibility: 'public', files: [file('a.md', 'a\n')], author },
  });
  const { id } = created.body;
  const s = sampling('1');
  const send = (path: string, init?: RequestInit) => {
    const req = new Request(`https://yoneda${path}`, init);
    return served({ env: s.env, req, waitUntil: s.waitUntil }, () => platformFetch(req, s.env));
  };
  const read = await send(`/api/v1/repos/${id}/refs`, { headers: { cookie } });
  expect(read.status).toBe(200);
  expect(read.headers.get('server-timing')).toContain('total;dur=');
  const main = (await read.json<{ refs: Record<string, string> }>()).refs['refs/heads/main'];
  const refs = await send(`/git/${id}.git/info/refs?service=git-upload-pack`);
  await refs.arrayBuffer();
  const clone = await send(`/git/${id}.git/git-upload-pack`, {
    method: 'POST',
    body: `0032want ${main}\n00000009done\n`,
  });
  await clone.arrayBuffer();
  await s.settle();
  expect(s.points.map((p) => p.indexes[0])).toEqual([
    'GET /api/v1/repos/:repo/refs',
    'GET /git/:repo/info/refs',
    'POST /git/:repo/git-upload-pack',
  ]);
});

it('stays out of every Traffic query', () => {
  const day = trafficSpan('7d', Date.parse('2026-10-20T00:00:00Z'));
  for (const who of ['humans', 'agents', 'bots'] as const)
    for (const [name, sql] of Object.entries(trafficQueries('events', day, who)))
      if (sql) expect(sql, name).toMatch(/blob1 (=|IN)/);
});

it('adds nothing to the answer with the switch on or off', async () => {
  const on = sampling('1');
  const off = sampling(undefined);
  const answer = async (s: ReturnType<typeof sampling>) => {
    const req = health({ authorization: 'Bearer nope' });
    const res = await served({ env: s.env, req, waitUntil: s.waitUntil }, () => platformFetch(req, s.env));
    await res.arrayBuffer();
    return [...res.headers.keys()].sort();
  };
  expect(await answer(on)).toEqual(await answer(off));
  await on.settle();
  expect(on.points).toHaveLength(1);
  expect(off.points).toEqual([]);
});
