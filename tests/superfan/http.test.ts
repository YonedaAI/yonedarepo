import { env, runInDurableObject } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SuperfanEnv } from '../../cloudflare/superfan/config';
import { superfanFetch, superfanTail } from '../../cloudflare/superfan/index';
import type { SuperfanLedger } from '../../cloudflare/superfan/ledger';
import { MIGRATIONS, migrate } from '../../cloudflare/superfan/ledger-schema';
import { analytics, fakeUpstreams, hour, testEnv } from './fake-platform';

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

  it('counts tail events and serves findings and status to the bearer', async () => {
    fakeUpstreams(analytics({ backlog: [5, 400] }));
    const e = testEnv({ DAILY_CAP_MICROUSD: '0' });
    await superfanTail(hour(Date.now() - 60_000), e);
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
      watching: 'yonedarepo-dev-platform',
      tail_events_last_hour: 350,
      analytics: 'cloudflare',
      open_findings: 1,
    });
    expect((await get(e, '/findings?status=bogus', 'fixture-read-token')).status).toBe(400);
  });
});

/** Takes away what came after version 4, for a test that rebuilds an older shape. */
function backToVersion4(sql: SqlStorage) {
  sql.exec('DROP TABLE queue_gaps');
  sql.exec('DROP TABLE queue_consumers');
  sql.exec('DROP TABLE probe_results');
  sql.exec('DROP TABLE deploys');
  sql.exec('ALTER TABLE findings DROP COLUMN revision');
  sql.exec('ALTER TABLE findings DROP COLUMN last_revision');
}

describe('superfan ledger schema', () => {
  it('upgrades a ledger created at the preceding schema', async () => {
    const stub = env.LEDGER.get(
      env.LEDGER.idFromName('schema-upgrade'),
    ) as DurableObjectStub<SuperfanLedger>;
    await runInDurableObject(stub, (_instance, state) => {
      const sql = state.storage.sql;
      // Rebuild the version-1 shape inside a fresh object, with a finding in it.
      backToVersion4(sql);
      for (const t of ['tail_samples', 'tail_minutes', 'tail_marks', 'urgent_notices', 'beats'])
        sql.exec(`DROP TABLE IF EXISTS ${t}`);
      sql.exec('ALTER TABLE findings DROP COLUMN level');
      sql.exec('ALTER TABLE findings DROP COLUMN notified_at');
      sql.exec('ALTER TABLE spend_days DROP COLUMN emails');
      sql.exec('UPDATE schema_version SET version = 1');
      sql.exec(
        "INSERT INTO findings (dedup_key, component, kind, status, signals, summary, narrative_status, first_seen, last_seen) VALUES ('a:b', 'a', 'anomaly', 'open', '[]', 's', 'pending', 1, 1)",
      );
      expect(migrate(sql)).toBe(MIGRATIONS.length);
      expect(sql.exec('SELECT COUNT(*) AS n FROM tail_minutes').one().n).toBe(0);
      expect(sql.exec('SELECT COUNT(*) AS n FROM findings').one().n).toBe(1);
      // A finding from before notices is not new.
      expect(sql.exec('SELECT notified_at FROM findings').one().notified_at).toBe(1);
      expect(sql.exec('SELECT emails FROM spend_days').toArray()).toEqual([]);
    });
  });

  it('upgrades a ledger at version 3: its findings become digest level', async () => {
    const stub = env.LEDGER.get(
      env.LEDGER.idFromName('schema-upgrade-4'),
    ) as DurableObjectStub<SuperfanLedger>;
    await runInDurableObject(stub, (_instance, state) => {
      const sql = state.storage.sql;
      backToVersion4(sql);
      for (const t of ['tail_marks', 'urgent_notices', 'beats'])
        sql.exec(`DROP TABLE IF EXISTS ${t}`);
      sql.exec('ALTER TABLE findings DROP COLUMN level');
      sql.exec('UPDATE schema_version SET version = 3');
      sql.exec(
        "INSERT INTO findings (dedup_key, component, kind, status, signals, summary, narrative_status, first_seen, last_seen, notified_at) VALUES ('a:b', 'a', 'anomaly', 'open', '[]', 's', 'pending', 1, 1, 1)",
      );
      expect(migrate(sql)).toBe(MIGRATIONS.length);
      expect(sql.exec('SELECT level FROM findings').one().level).toBe('digest');
      expect(sql.exec('SELECT COUNT(*) AS n FROM tail_marks').one().n).toBe(0);
      expect(sql.exec('SELECT COUNT(*) AS n FROM urgent_notices').one().n).toBe(0);
      expect(sql.exec('SELECT COUNT(*) AS n FROM beats').one().n).toBe(0);
    });
  });

  it('ends an open finding of the removed push queue, and no other', async () => {
    const stub = env.LEDGER.get(
      env.LEDGER.idFromName('schema-upgrade-push-queue'),
    ) as DurableObjectStub<SuperfanLedger>;
    await runInDurableObject(stub, (_instance, state) => {
      const sql = state.storage.sql;
      migrate(sql);
      sql.exec('UPDATE schema_version SET version = ?', MIGRATIONS.length - 1);
      const open = (key: string, component: string) =>
        sql.exec(
          "INSERT INTO findings (dedup_key, component, kind, status, signals, summary, narrative_status, first_seen, last_seen) VALUES (?, ?, 'anomaly', 'open', '[]', 's', 'pending', 1, 7)",
          key,
          component,
        );
      open('object_push_queue:push_retries', 'object_push_queue');
      open('source_repository:error_rate', 'source_repository');
      sql.exec(
        "INSERT INTO baselines (key, value, samples, updated_at) VALUES ('object_push_queue/p95_wall_ms', 1, 1, 1), ('api_worker/p95_wall_ms', 1, 1, 1)",
      );
      expect(migrate(sql)).toBe(MIGRATIONS.length);
      expect(
        sql.exec('SELECT component, status, resolved_at FROM findings ORDER BY id').toArray(),
      ).toEqual([
        { component: 'object_push_queue', status: 'resolved', resolved_at: 7 },
        { component: 'source_repository', status: 'open', resolved_at: null },
      ]);
      expect(sql.exec('SELECT key FROM baselines').toArray()).toEqual([
        { key: 'api_worker/p95_wall_ms' },
      ]);
    });
  });

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
