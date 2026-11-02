// The deploy ledger, and a finding naming its release. Times and commits are invented; nothing
// leaves the test.
import { env, runInDurableObject } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { superfanFetch } from '../../cloudflare/superfan/index';
import type { SuperfanLedger } from '../../cloudflare/superfan/ledger';
import { parseDeploy } from '../../cloudflare/superfan/ledger-deploys';
import { MIGRATIONS, migrate } from '../../cloudflare/superfan/ledger-schema';
import { renderNotice } from '../../cloudflare/superfan/mail-render';
import { runQuick } from '../../cloudflare/superfan/quick';
import { runWatch } from '../../cloudflare/superfan/watch';
import { analytics, deps, FRONT_URL, fakeUpstreams, feed, hour, testEnv } from './fake-platform';

const start = Date.parse('2026-10-20T15:07:00Z');
const OLD = 'a'.repeat(40);
const NEW = 'b'.repeat(40);
const HEALTH = 'https://yonedarepo-dev-platform.example.workers.dev/health';
const SCRIPT = 'yonedarepo-dev-platform';
const row = (over = {}) => ({
  revision: NEW,
  env: 'dev',
  who: 'github:someone',
  kind: 'deploy',
  outcome: 'ok',
  started_at: start - 60_000,
  finished_at: start,
  ...over,
});
const call = (
  e: ReturnType<typeof testEnv>,
  path: string,
  init: RequestInit = {},
  token = 'fixture-read-token',
) =>
  superfanFetch(
    new Request(`https://superfan.example${path}`, {
      ...init,
      headers: { authorization: `Bearer ${token}` },
    }),
    e,
  );
const post = (e: ReturnType<typeof testEnv>, body: unknown, token?: string) =>
  call(e, '/deploys', { method: 'POST', body: JSON.stringify(body) }, token);
afterEach(() => vi.restoreAllMocks());

describe('deploy ledger', () => {
  it('keeps a row, ignores its repeat, and serves it to the bearer alone', async () => {
    const stub = env.LEDGER.get(env.LEDGER.newUniqueId());
    const single = testEnv({ LEDGER: { idFromName: () => undefined, get: () => stub } as never });
    expect((await post(single, row(), 'wrong')).status).toBe(401);
    expect((await post(single, row())).status).toBe(200);
    // An answer was lost, so xtask sent it again.
    expect((await post(single, row())).status).toBe(200);
    const { deploys } = await (await call(single, '/deploys')).json<{ deploys: unknown[] }>();
    expect(deploys).toMatchObject([{ revision: NEW, who: 'github:someone', outcome: 'ok' }]);
    const status = await (await call(single, '/status')).json<{ last_deploy: unknown }>();
    expect(status.last_deploy).toMatchObject({ revision: NEW, kind: 'deploy' });
    expect((await call(single, '/deploys', { method: 'PUT' })).status).toBe(405);
  });

  it('keeps a bounded number of rows', async () => {
    const d = deps(testEnv(), { now: start });
    for (let i = 0; i < 3; i++) await d.ledger.recordDeploy(parseDeploy(row({ started_at: i + 1 }), SCRIPT)!);
    expect(await d.ledger.deploys(2)).toHaveLength(2);
  });

  it.each([
    ['a short commit', { revision: 'abc' }],
    ["another environment's row", { env: 'prod' }],
    ['an address for who', { who: 'someone@example.com' }],
    ['an unknown kind', { kind: 'cutover' }],
    ['an unknown outcome', { outcome: 'maybe' }],
    ['a time that is not a number', { started_at: 'soon' }],
    ['an end before its start', { finished_at: 1 }],
  ])('refuses %s', async (_what, over) => {
    expect(parseDeploy(row(over), SCRIPT)).toBeNull();
    expect((await post(testEnv(), row(over))).status).toBe(400);
  });

  it('refuses a body that is not JSON', async () => {
    const res = await call(testEnv(), '/deploys', { method: 'POST', body: 'not json' });
    expect(res.status).toBe(400);
  });
});

describe('findings carry the release', () => {
  const failing = { source_repository: { errors: 20 } };
  const health = (revision: string) => () =>
    Response.json({ service: 'yonedarepo-platform', v: 1, revision });

  it('records the release a problem began on and the one it is on now', async () => {
    const calls = fakeUpstreams(analytics());
    const clock = { now: start };
    const e = testEnv();
    const d = deps(e, clock);
    const pass = async (revision: string) => {
      calls.routes[HEALTH] = health(revision);
      await feed(d.ledger, hour(clock.now - 600_000, failing), clock.now);
      await runWatch(e, d);
      clock.now += 3_600_000;
    };
    await pass(OLD);
    await pass(OLD);
    expect(await d.ledger.findings('open', 5)).toMatchObject([{ revision: OLD, last_revision: OLD }]);
    await pass(NEW);
    const [finding] = await d.ledger.findings('open', 5);
    expect(finding).toMatchObject({ revision: OLD, last_revision: NEW });
    const { text } = renderNotice({ env: 'dev', site: '', api: '' }, [finding]);
    expect(text).toContain(`First on ${OLD.slice(0, 12)}, now on ${NEW.slice(0, 12)}.`);
  });

  it('falls back to the ledger when /health cannot say', async () => {
    const calls = fakeUpstreams(analytics());
    const e = testEnv();
    const d = deps(e, { now: start });
    await d.ledger.recordDeploy(parseDeploy(row(), SCRIPT)!);
    calls.routes[HEALTH] = () => new Response('down', { status: 503 });
    await feed(d.ledger, hour(start - 600_000), start);
    await runWatch(e, d);
    expect(await d.ledger.findings('open', 5)).toMatchObject([{ revision: NEW }]);
  });

  it('keeps no revision when neither knows, and ignores one that is not a commit', async () => {
    const calls = fakeUpstreams(analytics());
    const e = testEnv();
    const d = deps(e, { now: start });
    calls.routes[HEALTH] = health('development');
    await feed(d.ledger, hour(start - 600_000, failing), start);
    await runWatch(e, d);
    expect(await d.ledger.findings('open', 5)).toMatchObject([{ revision: null }]);
  });

  it('marks urgent findings of a quick pass too', async () => {
    const calls = fakeUpstreams(analytics());
    const e = testEnv({ WATCH_WIDE: 'on', WATCH_FRONT_URL: FRONT_URL });
    const d = deps(e, { now: start });
    await d.ledger.recordDeploy(parseDeploy(row(), SCRIPT)!);
    calls.routes[HEALTH] = () => new Response('down', { status: 503 });
    await runQuick(e, d);
    expect(await d.ledger.findings('open', 5)).toMatchObject([{ level: 'urgent', revision: NEW }]);
  });
});

describe('ledger schema', () => {
  it('upgrades a ledger at version 4: its findings name no release', async () => {
    const stub = env.LEDGER.get(env.LEDGER.idFromName('schema-upgrade-5')) as DurableObjectStub<SuperfanLedger>;
    await runInDurableObject(stub, (_instance, state) => {
      const sql = state.storage.sql;
      sql.exec('DROP TABLE queue_gaps');
      sql.exec('DROP TABLE queue_consumers');
      sql.exec('DROP TABLE probe_results');
      sql.exec('DROP TABLE deploys');
      sql.exec('ALTER TABLE findings DROP COLUMN revision');
      sql.exec('ALTER TABLE findings DROP COLUMN last_revision');
      sql.exec('UPDATE schema_version SET version = 4');
      sql.exec(
        "INSERT INTO findings (dedup_key, component, kind, status, signals, summary, narrative_status, first_seen, last_seen) VALUES ('a:b', 'a', 'anomaly', 'open', '[]', 's', 'pending', 1, 1)",
      );
      expect(migrate(sql)).toBe(MIGRATIONS.length);
      expect(migrate(sql)).toBe(MIGRATIONS.length);
      expect(sql.exec('SELECT revision, last_revision FROM findings').one()).toEqual({
        revision: null,
        last_revision: null,
      });
      expect(sql.exec('SELECT COUNT(*) AS n FROM deploys').one().n).toBe(0);
    });
  });
});
