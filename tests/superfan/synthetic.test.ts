// The synthetic pass against fakes: nothing here reaches a network. tests/workers/
// synthetic-platform.test.ts runs the same checks against the real platform.
import { env, runInDurableObject } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import devSpec from '../../infra/envs/dev.json?raw';
import prodSpec from '../../infra/envs/prod.json?raw';
import { COPY } from '../../cloudflare/superfan/mail-copy';
import type { SuperfanEnv } from '../../cloudflare/superfan/config';
import { superfanFetch } from '../../cloudflare/superfan/index';
import type { SuperfanLedger } from '../../cloudflare/superfan/ledger';
import { MIGRATIONS, migrate } from '../../cloudflare/superfan/ledger-schema';
import { renderUrgent } from '../../cloudflare/superfan/mail-render';
import { cloneRequest, PROBE_CHECKS, runCheck } from '../../cloudflare/superfan/synthetic-checks';
import { runProbes } from '../../cloudflare/superfan/synthetic';
import { runWatch } from '../../cloudflare/superfan/watch';
import {
  analytics,
  deps,
  FRONT_URL,
  fakeUpstreams,
  feed,
  hour,
  RESEND_KEY,
  testEnv,
} from './fake-platform';

const MINUTE = 60_000;
// A pass whose number is a multiple of three: the landing is due.
const start = Math.ceil(Date.parse('2026-10-20T15:07:00Z') / (15 * MINUTE)) * (15 * MINUTE);
const API = 'https://yonedarepo-dev-platform.example.workers.dev';
const REPO = `r${'0'.repeat(20)}`;
const COMMIT = 'c'.repeat(40);
const REVISION = 'd'.repeat(40);
const TOKEN = 'fixture-land-token';

const on = (over: Partial<SuperfanEnv> = {}) =>
  testEnv({
    PROBES: 'on',
    WATCH_FRONT_URL: FRONT_URL,
    PROBE_CLONE_REPO: REPO,
    ADMIN_NOTIFY_EMAIL: 'owner@yonedarepo.invalid',
    EMAIL_FROM: 'YonedaRepo <hello@yonedarepo.invalid>',
    RESEND_API_KEY: { get: async () => RESEND_KEY } as SecretsStoreSecret,
    ...over,
  });
const landing = (over: Partial<SuperfanEnv> = {}) =>
  on({
    PROBE_LANDING: 'on',
    PROBE_LAND_REPO: REPO,
    PROBE_LAND_TOKEN: TOKEN,
    ...over,
  });

async function pack() {
  const body = new TextEncoder().encode('PACK\0\0\0\2\0\0\0\0');
  const sum = new Uint8Array(await crypto.subtle.digest('SHA-1', body));
  return new Blob([new TextEncoder().encode('0008NAK\n'), body, sum]);
}

/** A healthy site, every call recorded. */
async function site() {
  const calls = fakeUpstreams(analytics());
  const packed = await pack();
  const seen: { url: string; init?: RequestInit }[] = [];
  const route = (url: string, answer: () => Response) => {
    calls.routes[url] = answer;
  };
  route(`${FRONT_URL}/health`, () =>
    Response.json({ service: 'yonedarepo', v: 1, revision: REVISION }),
  );
  route(`${FRONT_URL}/`, () => new Response('<!doctype html><title>x</title>'));
  route(`${FRONT_URL}/api/v1/explore?limit=1`, () => Response.json({ repos: [] }));
  route(
    `${API}/git/${REPO}.git/info/refs?service=git-upload-pack`,
    () => new Response(`001e# service=git-upload-pack\n0000003d${COMMIT} refs/heads/main\n0000`),
  );
  route(`${API}/git/${REPO}.git/git-upload-pack`, () => new Response(packed));
  route(`${API}/api/v1/repos/${REPO}/commits`, () => Response.json({ commit: COMMIT }));
  route(`${API}/api/v1/repos/${REPO}/land`, () => Response.json({ version: 7 }));
  const spy = vi.mocked(globalThis.fetch);
  const answer = spy.getMockImplementation() as typeof fetch;
  spy.mockImplementation((input, init) => {
    seen.push({ url: String(input), init });
    return answer(input, init);
  });
  return { calls, seen, route };
}
const down = () => new Response('private text', { status: 503, headers: { 'cf-ray': 'abc-SJC' } });
const keys = async (d: ReturnType<typeof deps>) =>
  (await d.ledger.findings('open', 20)).map((f) => f.dedup_key);
afterEach(() => vi.restoreAllMocks());

describe('the switch', () => {
  it('spends nothing while off', async () => {
    const { seen } = await site();
    const e = testEnv({ PROBE_CLONE_REPO: REPO, WATCH_FRONT_URL: FRONT_URL });
    const d = deps(e, { now: start });
    const spy = vi.spyOn(d.ledger, 'recordProbes');
    expect(await runProbes(e, d)).toBeNull();
    expect(seen).toEqual([]);
    expect(spy).not.toHaveBeenCalled();
  });

  it('is off in both specs, and only dev can name a landing', () => {
    const vars = (text: string) =>
      JSON.parse(text).workers.find((w: { role: string }) => w.role === 'superfan').config.vars;
    expect(vars(devSpec)).toMatchObject({ PROBES: 'off', PROBE_LANDING: 'off' });
    expect(vars(prodSpec).PROBES).toBe('off');
    expect(vars(prodSpec).PROBE_LANDING).toBeUndefined();
  });

  it('names the five-minute cron in both specs', () => {
    for (const text of [devSpec, prodSpec]) {
      const superfan = JSON.parse(text).workers.find((w: { role: string }) => w.role === 'superfan');
      expect(superfan.config.triggers.crons).toContain('*/5 * * * *');
    }
  });

  it('asks the hourly pass to report a site it cannot find', async () => {
    await site();
    const e = on({ WATCH_FRONT_URL: undefined });
    const d = deps(e, { now: start });
    expect(await runProbes(e, d)).toBeNull();
    expect(d.target).toBeInstanceOf(Error);
  });
});

describe('a pass', () => {
  it('runs four checks on a healthy site, marked as our own, with no landing', async () => {
    const { seen } = await site();
    const e = on();
    const d = deps(e, { now: start });
    expect(await runProbes(e, d)).toEqual({ checks: 4, failing: 0 });
    const probes = seen.filter((s) => !s.url.includes('resend'));
    expect(probes).toHaveLength(5);
    for (const { init } of probes)
      expect(init?.headers).toMatchObject({
        'x-yoneda-own-traffic': '1',
        'user-agent': 'yonedarepo-probe/1',
      });
    expect(await keys(d)).toEqual([]);
  });

  it('leaves the clone out until a repository is named', async () => {
    await site();
    const e = on({ PROBE_CLONE_REPO: undefined });
    expect(await runProbes(e, deps(e, { now: start }))).toEqual({ checks: 3, failing: 0 });
  });

  it('lands on dev every third pass, as a commit then a landing', async () => {
    const { seen } = await site();
    const e = landing();
    const clock = { now: start };
    const d = deps(e, clock);
    expect(await runProbes(e, d)).toEqual({ checks: 5, failing: 0 });
    const writes = seen.filter((s) => s.init?.method === 'POST' && s.url.includes('/api/v1/repos/'));
    expect(writes.map((w) => w.url.split('/').at(-1))).toEqual(['commits', 'land']);
    expect(writes[0].init?.headers).toMatchObject({ authorization: `Bearer ${TOKEN}` });
    expect(JSON.parse(String(writes[1].init?.body))).toEqual({ ref: 'main', commit: COMMIT });
    clock.now += 5 * MINUTE;
    expect(await runProbes(e, d)).toEqual({ checks: 4, failing: 0 });
    clock.now += 10 * MINUTE;
    expect(await runProbes(e, d)).toEqual({ checks: 5, failing: 0 });
  });

  it('never lands on prod, whatever the switch says', async () => {
    const { seen } = await site();
    const e = landing({
      WATCH_SCRIPT: 'yonedarepo-prod-platform',
      WATCH_URL: 'https://yonedarepo-prod-platform.example.workers.dev',
      PROBE_CLONE_REPO: undefined,
    });
    const d = deps(e, { now: start });
    expect(await runProbes(e, d)).toEqual({ checks: 3, failing: 0 });
    expect(seen.filter((s) => s.init?.method === 'POST' && !s.url.includes('resend'))).toEqual([]);
  });
});

describe('failing', () => {
  it('stays quiet for one bad pass, files and mails on the second, and ends on recovery', async () => {
    const { route, calls } = await site();
    const e = on();
    const clock = { now: start };
    const d = deps(e, clock);
    route(`${API}/git/${REPO}.git/git-upload-pack`, down);
    expect(await runProbes(e, d)).toEqual({ checks: 4, failing: 0 });
    expect(await keys(d)).toEqual([]);
    clock.now += 5 * MINUTE;
    expect(await runProbes(e, d)).toEqual({ checks: 4, failing: 1 });
    const [finding] = await d.ledger.findings('open', 5);
    expect(finding).toMatchObject({
      dedup_key: 'synthetic:probe_clone',
      level: 'urgent',
      revision: REVISION,
    });
    expect(calls.mail).toHaveLength(1);
    expect(calls.mail[0].body.subject).toBe('[URGENT dev] Public clone failing from outside');
    expect(calls.mail[0].body.text).toContain('last with HTTP 503');
    route(`${API}/git/${REPO}.git/git-upload-pack`, () => new Response(new Blob(['x'])));
    const healthy = await pack();
    route(`${API}/git/${REPO}.git/git-upload-pack`, () => new Response(healthy));
    clock.now += 5 * MINUTE;
    await runProbes(e, d);
    expect(await keys(d)).toEqual([]);
  });

  it('keeps what failed and its request id, never the answer or a token', async () => {
    const { route } = await site();
    const e = landing();
    const d = deps(e, { now: start });
    route(`${API}/api/v1/repos/${REPO}/land`, down);
    await runProbes(e, d);
    const answer = await superfanFetch(
      new Request('https://superfan.example/probes', {
        headers: { authorization: 'Bearer fixture-read-token' },
      }),
      { ...e, LEDGER: { idFromName: () => undefined, get: () => d.ledger } as never },
    );
    const { probes } = await answer.json<{ probes: Record<string, unknown>[] }>();
    const failed = probes.find((p) => p.check_name === 'land');
    expect(failed).toMatchObject({ ok: 0, status: 503, detail: 'land: HTTP 503, id abc-SJC' });
    expect(JSON.stringify(probes)).not.toContain('private text');
    expect(JSON.stringify(probes)).not.toContain(TOKEN);
    expect(JSON.stringify(probes)).not.toContain(REPO);
  });

  it('says nothing of a check that stopped running', async () => {
    const { route } = await site();
    const failing = on();
    const clock = { now: start };
    const d = deps(failing, clock);
    route(`${API}/git/${REPO}.git/git-upload-pack`, down);
    await runProbes(failing, d);
    clock.now += 5 * MINUTE;
    await runProbes(failing, d);
    expect(await keys(d)).toContain('synthetic:probe_clone');
    clock.now += 45 * MINUTE;
    const stopped = on({ PROBE_CLONE_REPO: undefined });
    await runProbes(stopped, { ...d, now: () => clock.now });
    expect(await keys(d)).not.toContain('synthetic:probe_clone');
  });

  it('lets the hourly pass end a finding once the switch is off', async () => {
    const { route } = await site();
    const e = on();
    const clock = { now: start };
    const d = deps(e, clock);
    route(`${FRONT_URL}/`, down);
    await runProbes(e, d);
    clock.now += 5 * MINUTE;
    await runProbes(e, d);
    expect(await keys(d)).toEqual(['synthetic:probe_page']);
    clock.now += 5 * MINUTE;
    await feed(d.ledger, hour(clock.now - 60_000), clock.now);
    const off = testEnv();
    await runWatch(off, d);
    expect(await keys(d)).toEqual([]);
  });

  it('tries again once before a result counts', async () => {
    let tries = 0;
    const fetcher = (async () => {
      tries++;
      return tries === 1 ? down() : new Response('<!doctype html>');
    }) as typeof fetch;
    const pause = vi.fn(async () => {});
    const result = await runCheck('page', { front: FRONT_URL, api: API }, pause, fetcher);
    expect(result).toMatchObject({ check: 'page', ok: true, status: 200, detail: null });
    expect(tries).toBe(2);
    expect(pause).toHaveBeenCalledTimes(1);
  });

  it('calls a timeout and a lost connection what they are', async () => {
    const pause = async () => {};
    const targets = { front: FRONT_URL, api: API };
    const timeout = (async () => {
      throw new DOMException('slow', 'TimeoutError');
    }) as typeof fetch;
    expect(await runCheck('health', targets, pause, timeout)).toMatchObject({
      ok: false,
      status: null,
      detail: 'timed out',
    });
    const lost = (async () => {
      throw new TypeError('network');
    }) as typeof fetch;
    expect(await runCheck('health', targets, pause, lost)).toMatchObject({ detail: 'no answer' });
  });

  it.each([
    ['a page with no HTML', 'page', () => new Response('nothing')],
    ['a health answer from something else', 'health', () => Response.json({ service: 'other' })],
    ['a list that is not one', 'api', () => Response.json({ repos: 1 })],
    ['a redirect', 'page', () => new Response(null, { status: 302, headers: { location: '/x' } })],
  ] as const)('fails %s', async (_what, check, answer) => {
    const fetcher = (async () => answer()) as typeof fetch;
    const result = await runCheck(check, { front: FRONT_URL, api: API }, async () => {}, fetcher);
    expect(result.ok).toBe(false);
  });

  const cloning = (upload: () => Response) =>
    (async (url: string) =>
      String(url).includes('info/refs')
        ? new Response(`${COMMIT} refs/heads/main\n`)
        : upload()) as typeof fetch;
  const repoTargets = { front: FRONT_URL, api: API, cloneRepo: REPO };

  it('fails a pack that does not match its checksum', async () => {
    const body = new Uint8Array(await (await pack()).arrayBuffer());
    body[body.length - 1] ^= 1;
    const result = await runCheck('clone', repoTargets, async () => {}, cloning(() => new Response(body)));
    expect(result).toMatchObject({ ok: false, detail: 'clone: the pack fails its checksum' });
  });

  it('stops reading a repository too large for a probe', async () => {
    const big = () => new Response(new Blob([new Uint8Array(2 * 1024 * 1024)]));
    const result = await runCheck('clone', repoTargets, async () => {}, cloning(big));
    expect(result).toMatchObject({ detail: 'clone: the probe repository is too large' });
  });

  it('refuses a repository that is not one', async () => {
    const result = await runCheck('clone', { ...repoTargets, cloneRepo: '../x' }, async () => {}, fetch);
    expect(result).toMatchObject({ detail: 'clone: PROBE_CLONE_REPO is malformed' });
  });
});

describe('wire and words', () => {
  it('asks for a clone in pkt-lines', () => {
    expect(cloneRequest(COMMIT)).toBe(`0032want ${COMMIT}\n00000009done\n`);
  });

  it('has words for every check, with no raw name', () => {
    for (const check of PROBE_CHECKS) {
      const name = `probe_${check}`;
      expect(COPY.some((c) => c.signals.includes(name))).toBe(true);
      for (const value of [503, null]) {
        const { subject, text } = renderUrgent({ env: 'dev', site: 'https://s', api: 'https://a' }, [
          {
            dedup_key: `synthetic:${name}`,
            component: 'synthetic',
            kind: 'anomaly',
            level: 'urgent',
            status: 'open',
            signals: { signals: [{ name, value }], exception_samples: [] },
            summary: '',
            narrative: null,
            occurrences: 1,
            first_seen: '2026-10-20T15:00:00.000Z',
            last_seen: '2026-10-20T15:05:00.000Z',
          } as never,
        ]);
        const words = `${subject}\n${text}`.replace(/[\w*]+\.[\w.]+/g, '');
        expect(words).not.toMatch(/undefined|NaN|[a-z]+_[a-z]+|Something needs a look/);
      }
    }
  });
});

describe('ledger schema', () => {
  it('upgrades a ledger at version 5 and keeps two days of results', async () => {
    const stub = env.LEDGER.get(env.LEDGER.idFromName('schema-upgrade-6')) as DurableObjectStub<SuperfanLedger>;
    await runInDurableObject(stub, (_instance, state) => {
      const sql = state.storage.sql;
      sql.exec('DROP TABLE probe_results');
      sql.exec('UPDATE schema_version SET version = 5');
      expect(migrate(sql)).toBe(MIGRATIONS.length);
      expect(sql.exec('SELECT COUNT(*) AS n FROM probe_results').one().n).toBe(0);
    });
    const result = { check: 'page', ok: true, status: 200, ms: 1, detail: null, revision: null } as const;
    await stub.recordProbes([result], start);
    await stub.recordProbes([result], start + 49 * 60 * MINUTE);
    expect(await stub.probes(10)).toHaveLength(1);
  });
});
