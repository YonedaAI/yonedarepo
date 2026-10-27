import {
  evictDurableObject,
  reset,
  runDurableObjectAlarm,
  runInDurableObject,
} from 'cloudflare:test';
import { afterEach, expect, it } from 'vitest';
import { ledger } from '../../cloudflare/worker/storage';
import { bindings, initialize, meter, start, stub } from './load-fixture';

afterEach(reset);

it('bounds admission and recovers contended expired claims with real SQLite and the production alarm', async () => {
  const repo = 'load-recovery';
  await initialize(repo);
  const measured = meter();
  let passed = false;
  let alarmMs: number | null = null;
  try {
    const starts = await Promise.all(
      Array.from({ length: 64 }, (_, i) =>
        measured.call(repo, start(`admission-${i}`, repo), ['ACTIVE_RUN_LIMIT']),
      ),
    );
    const admitted = starts.filter((run) => run !== null);
    expect(admitted).toHaveLength(6);
    expect(starts.filter((run) => run === null)).toHaveLength(58);
    const before = await ledger(bindings, repo, { op: 'snapshot' });
    expect(before.runs).toHaveLength(6);
    expect(before.executions).toHaveLength(6);
    expect(before.seq).toBe(7);
    const claims = async () => {
      for (const run of admitted) {
        const winners = await Promise.all(
          Array.from({ length: 8 }, () =>
            measured.call(repo, { op: 'claim', job_id: `job:${run.id}:agent-1` }, ['LEASE_HELD']),
          ),
        );
        expect(winners.filter(Boolean)).toHaveLength(1);
      }
    };
    await claims();
    // Controlled incident: expire six leases through SQL. Recovery itself is production Rust.
    await runInDurableObject(stub(repo), (_instance, state) => {
      state.storage.sql.exec(
        "UPDATE jobs SET payload=json_set(payload,'$.lease_until',0) WHERE json_extract(payload,'$.status')='running'",
      );
    });
    await evictDurableObject(stub(repo));
    const began = performance.now();
    expect(await runDurableObjectAlarm(stub(repo))).toBe(true);
    alarmMs = performance.now() - began;
    expect(await measured.call(repo, { op: 'recover' })).toEqual({ recovered: 0 });
    // A sandbox attempt is single-shot: an expired lease fails it terminally, with no retry.
    const recovered = await runInDurableObject(stub(repo), (_instance, state) => ({
      failed: state.storage.sql
        .exec("SELECT id FROM jobs WHERE json_extract(payload,'$.status')='failed'")
        .toArray(),
      retries: state.storage.sql
        .exec("SELECT id FROM outbox WHERE kind='agent' AND id LIKE '%:2' AND delivered=0")
        .toArray(),
      events: state.storage.sql.exec("SELECT seq FROM events WHERE kind='job.recovered'").toArray(),
    }));
    expect(recovered.failed).toHaveLength(6);
    expect(recovered.retries).toHaveLength(0);
    expect(recovered.events).toHaveLength(6);
    for (const run of admitted) {
      const job = `job:${run.id}:agent-1`;
      expect(await measured.call(repo, { op: 'job_status', id: job })).toMatchObject({
        epoch: 1,
        attempt: 2,
        status: 'failed',
      });
      expect(
        await measured.call(repo, { op: 'claim', job_id: job }, ['FENCED', 'ATTEMPTS_EXHAUSTED']),
      ).toBeNull();
      const late = {
        op: 'sandbox_progress',
        job_id: job,
        epoch: 1,
        activity: { phase: 'running', last_activity_at: 1 },
      };
      expect(await measured.call(repo, late, ['FENCED'])).toBeNull();
    }
    const failed = await ledger(bindings, repo, { op: 'snapshot' });
    // Duplicate creation must leave run/execution/graph state, events and outbox intact.
    await Promise.all(
      Array.from({ length: 32 }, () =>
        measured.call(repo, start(admitted[0].id, repo), ['ALREADY_EXISTS']),
      ),
    );
    expect(await ledger(bindings, repo, { op: 'snapshot' })).toEqual(failed);
    await evictDurableObject(stub(repo));
    expect(await ledger(bindings, repo, { op: 'snapshot' })).toEqual(failed);
    passed = true;
  } finally {
    measured.report('recovery', {
      repositories: 1,
      admission_concurrency: 64,
      claim_contenders_per_job: 8,
      simulated_incident: 'six running leases expired by direct SQL',
      recovery: 'production Rust alarm after eviction',
      alarm_ms: alarmMs,
      workload_passed: passed,
      invariants: passed
        ? [
            'six admitted of 64',
            'one winner per claim race',
            'six single-shot attempts failed terminally, no retry dispatch',
            'idempotent recovery',
            'stale/terminal work fenced',
            'duplicate transaction rollback',
            'storage/graph/events/outbox parity after eviction',
          ]
        : [],
    });
  }
}, 120_000);
