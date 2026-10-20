import {
  evictDurableObject,
  reset,
  runDurableObjectAlarm,
  runInDurableObject,
} from 'cloudflare:test';
import { afterEach, expect, it } from 'vitest';
import { ledger } from '../../cloudflare/worker/storage';
import { audit, bindings, initialize, meter, start, stub } from './load-fixture';

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
    const retry = await runInDurableObject(stub(repo), (_instance, state) => ({
      queued: state.storage.sql
        .exec("SELECT id FROM jobs WHERE json_extract(payload,'$.status')='queued'")
        .toArray(),
      dispatch: state.storage.sql
        .exec("SELECT id FROM outbox WHERE kind='agent' AND id LIKE '%:1' AND delivered=0")
        .toArray(),
      events: state.storage.sql.exec("SELECT seq FROM events WHERE kind='job.recovered'").toArray(),
    }));
    expect(retry.queued).toHaveLength(6);
    expect(retry.dispatch).toHaveLength(6);
    expect(retry.events).toHaveLength(6);
    await claims();
    for (const run of admitted) {
      const job = `job:${run.id}:agent-1`;
      expect(await measured.call(repo, { op: 'job_status', id: job })).toMatchObject({
        epoch: 2,
        attempt: 2,
        status: 'running',
      });
      expect(
        await measured.call(repo, { op: 'heartbeat', job_id: job, epoch: 1 }, ['FENCED']),
      ).toBeNull();
      await measured.call(repo, { op: 'cancel_run', run_id: run.id });
      expect(
        await measured.call(
          repo,
          { op: 'progress', job_id: job, epoch: 2, progress: { stage: 'late_fixture' } },
          ['FENCED'],
        ),
      ).toBeNull();
    }
    const cancelled = await audit(repo, 6);
    // Duplicate creation must leave run/execution/graph state, events and outbox intact.
    await Promise.all(
      Array.from({ length: 32 }, () =>
        measured.call(repo, start(admitted[0].id, repo), ['ALREADY_EXISTS']),
      ),
    );
    expect(await audit(repo, 6)).toEqual(cancelled);
    await evictDurableObject(stub(repo));
    expect(await audit(repo, 6)).toEqual(cancelled);
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
            'six durable retry dispatches',
            'idempotent recovery',
            'incremented epochs',
            'stale/terminal work fenced',
            'duplicate transaction rollback',
            'storage/graph/events/outbox parity after eviction',
          ]
        : [],
    });
  }
}, 120_000);
