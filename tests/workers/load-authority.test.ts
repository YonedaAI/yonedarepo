import { evictDurableObject, reset } from 'cloudflare:test';
import { afterEach, expect, it } from 'vitest';
import { ledger } from '../../cloudflare/worker/storage';
import { audit, bindings, initialize, meter, pool, start, stub } from './load-fixture';

afterEach(reset);

// Fixed bounded sweeps, with four simultaneous work runs per repository (limit: six).
for (const [repositories, concurrency] of [
  [1, 1],
  [1, 4],
  [8, 32],
  [16, 64],
]) {
  it(`real workerd SQLite load: ${repositories} repositories, ${concurrency} clients`, async () => {
    const repos = Array.from(
      { length: repositories },
      (_, i) => `load-${repositories}-${concurrency}-${i}`,
    );
    await Promise.all(repos.map(initialize));
    // Warm each authority without adding work/history before the measured phase.
    await Promise.all(repos.map((repo) => ledger(bindings, repo, { op: 'repository_overview' })));
    const measured = meter();
    let passed = false;
    try {
      for (let wave = 0; wave < 4; wave++) {
        const tasks = repos.flatMap((repo) =>
          Array.from({ length: 4 }, (_, i) => ({ repo, run: `wave-${wave}-${i}` })),
        );
        await pool(tasks, concurrency, async ({ repo, run }) => {
          const created = await measured.call(repo, start(run, repo));
          expect(created?.id).toBe(run);
          const job = `job:${run}:agent-1`;
          const claim = await measured.call(repo, { op: 'claim', job_id: job });
          expect(claim).toMatchObject({ epoch: 1, attempt: 1, status: 'running' });
          await measured.call(repo, {
            op: 'progress',
            job_id: job,
            epoch: 1,
            progress: { stage: 'offline_load_fixture' },
          });
          expect(await measured.call(repo, { op: 'job_status', id: job })).toMatchObject({
            status: 'running',
            epoch: 1,
            progress: { stage: 'offline_load_fixture' },
          });
          const page = await measured.call(repo, { op: 'runs_page', limit: 20 });
          expect(page?.items.some((item: { id: string }) => item.id === run)).toBe(true);
          expect(await measured.call(repo, { op: 'cancel_run', run_id: run })).toMatchObject({
            status: 'cancelled',
          });
        });
      }
      // Verification/eviction excluded from throughput measurement; separately timed below.
      passed = true;
    } finally {
      measured.report(`authority-${repositories}-${concurrency}`, {
        repositories,
        concurrency,
        waves: 4,
        runs: repositories * 16,
        commands_per_run: 6,
        workload_passed: passed,
      });
    }
    const began = performance.now();
    for (const repo of repos) {
      const before = await audit(repo, 16);
      await evictDurableObject(stub(repo));
      expect(await audit(repo, 16)).toEqual(before);
    }
    console.log(
      `YONEDA_LOAD_AUDIT ${JSON.stringify({
        name: `authority-${repositories}-${concurrency}`,
        passed: true,
        repositories_evicted: repositories,
        elapsed_ms: performance.now() - began,
        invariants: [
          'exact run/execution/job counts',
          'terminal cancellation',
          'execution graph parity',
          'contiguous events',
          'dispatch/stop/live outbox persisted',
          'unchanged canonical HEAD',
          'exact storage readback after eviction',
        ],
      })}`,
    );
  }, 120_000);
}
