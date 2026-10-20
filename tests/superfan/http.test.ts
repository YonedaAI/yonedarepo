import { env, runInDurableObject } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SuperfanEnv } from '../../cloudflare/superfan/config';
import { superfanFetch } from '../../cloudflare/superfan/index';
import type { SuperfanLedger } from '../../cloudflare/superfan/ledger';
import { MIGRATIONS, migrate } from '../../cloudflare/superfan/ledger-schema';
import { analytics, fakeUpstreams, testEnv } from './fake-platform';

afterEach(() => vi.restoreAllMocks());
const get = (e: SuperfanEnv, path: string, token?: string) =>
  superfanFetch(
    new Request(`https://superfan.example${path}`, {
      headers: token ? { authorization: `Bearer ${token}` } : {},
    }),
    e,
  );

describe('superfan read endpoint', () => {
  it('refuses missing, wrong and unconfigured bearers', async () => {
    const e = testEnv();
    expect((await get(e, '/findings')).status).toBe(401);
    expect((await get(e, '/findings', 'fixture-read-tokem')).status).toBe(401);
    expect(
      (await get(testEnv({ SUPERFAN_READ_TOKEN: undefined }), '/findings', 'anything')).status,
    ).toBe(401);
    expect((await get(e, '/elsewhere', 'fixture-read-token')).status).toBe(404);
    const run = await superfanFetch(
      new Request('https://superfan.example/run', { method: 'POST' }),
      e,
    );
    expect(run.status).toBe(401);
  });

  it('serves findings and status to the bearer', async () => {
    fakeUpstreams(analytics({ backlog: [5, 400] }));
    const e = testEnv({ DAILY_CAP_MICROUSD: '0' });
    const run = await superfanFetch(
      new Request('https://superfan.example/run', {
        method: 'POST',
        headers: { authorization: 'Bearer fixture-read-token' },
      }),
      e,
    );
    expect(await run.json()).toMatchObject({ outcome: 'ok', anomalies: 1, modelCalls: 0 });
    const findings = await get(e, '/findings', 'fixture-read-token');
    expect(findings.status).toBe(200);
    expect(await findings.json()).toMatchObject({
      findings: [{ component: 'derived_jobs', narrative_status: 'budget_exhausted' }],
    });
    const status = await (await get(e, '/status', 'fixture-read-token')).json();
    expect(status).toMatchObject({
      watching: 'yonedarepo-platform-dev',
      telemetry: 'cloudflare',
      open_findings: 1,
    });
    expect((await get(e, '/findings?status=bogus', 'fixture-read-token')).status).toBe(400);
  });
});

describe('superfan ledger schema', () => {
  it('creates fresh and reapplies without change', async () => {
    const stub = env.LEDGER.get(
      env.LEDGER.idFromName('schema-test'),
    ) as DurableObjectStub<SuperfanLedger>;
    await runInDurableObject(stub, (_instance, state) => {
      expect(migrate(state.storage.sql)).toBe(MIGRATIONS.length);
      expect(migrate(state.storage.sql)).toBe(MIGRATIONS.length);
      const tables = state.storage.sql
        .exec<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
        .toArray()
        .map((t) => t.name);
      expect(tables).toEqual(
        expect.arrayContaining([
          'baselines',
          'findings',
          'reservations',
          'run_lease',
          'runs',
          'spend_days',
        ]),
      );
    });
  });
});
