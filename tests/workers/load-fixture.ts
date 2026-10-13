import { runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { expect } from 'vitest';
import { ledger } from '../../cloudflare/worker/storage';
import type { Env, Json } from '../../cloudflare/worker/types';
import { loadMarker, summarize } from '../../tools/load-metrics.mjs';

export const bindings = env as unknown as Env;
export const stub = (repo: string) =>
  bindings.REPOSITORIES.get(bindings.REPOSITORIES.idFromName(repo));
export const start = (id: string) => ({
  op: 'start_run',
  id,
  intent: 'Offline authority load fixture',
  criteria: ['Ledger invariants'],
  agents: [{ provider: 'codex', model: 'gpt-5.6-luna', strategy: 'Offline; dispatch withheld' }],
});

export async function initialize(repo: string) {
  await ledger(bindings, repo, {
    op: 'init',
    id: repo,
    name: 'Offline load fixture',
    remote: { namespace: 'yoneda-test', name: repo },
    commit: 'a'.repeat(40),
    policy: {
      version: 'load-v1',
      suite: 'commands-v1',
      environment: 'linux-node24-rust1.94-v1',
      required_checks: ['build'],
      build: {
        setup: [],
        checks: [{ name: 'build', argv: ['node', '--check', 'app.js'], timeout_seconds: 30 }],
      },
    },
  });
}

type Sample = { op: string; ms: number; code: string; expected: boolean };
export function meter() {
  const samples: Sample[] = [];
  let active = 0;
  let peak = 0;
  const began = performance.now();
  return {
    async call(repo: string, command: Json, allowedErrors: string[] = []): Promise<Json | null> {
      const at = performance.now();
      peak = Math.max(peak, ++active);
      let code = 'OK';
      let expected = false;
      try {
        return await ledger(bindings, repo, command);
      } catch (error) {
        code = (error as { code?: string }).code ?? 'UNCLASSIFIED';
        expected = allowedErrors.includes(code);
        if (!expected) throw error;
        return null;
      } finally {
        active--;
        samples.push({ op: command.op, ms: performance.now() - at, code, expected });
      }
    },
    report(name: string, details: Json) {
      console.log(
        loadMarker +
          JSON.stringify({
            name,
            ...details,
            peak_in_flight: peak,
            metrics: summarize(samples, performance.now() - began),
          }),
      );
    },
  };
}

// A closed-loop client pool: latency starts at submission, not at queued task creation.
export async function pool<T>(items: T[], concurrency: number, work: (item: T) => Promise<void>) {
  let next = 0;
  const results = await Promise.allSettled(
    Array.from({ length: Math.min(items.length, concurrency) }, async () => {
      while (next < items.length) await work(items[next++]);
    }),
  );
  for (const result of results) if (result.status === 'rejected') throw result.reason;
}

export async function audit(repo: string, expectedRuns: number) {
  const snapshot = await ledger(bindings, repo, { op: 'snapshot' });
  expect(snapshot.runs).toHaveLength(expectedRuns);
  expect(snapshot.executions).toHaveLength(expectedRuns);
  expect(snapshot.runs.every((run: Json) => run.status === 'cancelled')).toBe(true);
  expect(snapshot.executions.every((execution: Json) => execution.status === 'cancelled')).toBe(
    true,
  );
  for (const execution of snapshot.executions)
    expect(snapshot.nodes.find((node: Json) => node.id === execution.id)?.data).toEqual(execution);
  expect(snapshot.repository).toMatchObject({
    head_commit: 'a'.repeat(40),
    published_commit: 'a'.repeat(40),
    version: 0,
  });
  const stored = await runInDurableObject(stub(repo), (_instance, state) => ({
    jobs: state.storage.sql.exec('SELECT id,payload FROM jobs ORDER BY id').toArray(),
    events: state.storage.sql.exec('SELECT seq,kind,data FROM events ORDER BY seq').toArray(),
    outbox: state.storage.sql
      .exec('SELECT id,kind,payload,delivered FROM outbox ORDER BY id')
      .toArray(),
  }));
  expect(stored.jobs).toHaveLength(expectedRuns);
  const jobs = stored.jobs.map((row) => JSON.parse(row.payload as string));
  expect(jobs.every((job) => job.status === 'cancelled')).toBe(true);
  expect(stored.events.map((row) => row.seq)).toEqual(
    Array.from({ length: stored.events.length }, (_, i) => i + 1),
  );
  expect(snapshot.seq).toBe(stored.events.length);
  expect(stored.events.filter((row) => row.kind === 'run.created')).toHaveLength(expectedRuns);
  expect(stored.events.filter((row) => row.kind === 'run.cancelled')).toHaveLength(expectedRuns);
  for (const job of jobs) {
    expect(
      stored.outbox.some((row) => row.id === `dispatch:${job.id}:0` && row.delivered === 0),
    ).toBe(true);
    expect(
      stored.outbox.some(
        (row) => row.kind === 'stop' && JSON.parse(row.payload as string).job_id === job.id,
      ),
    ).toBe(true);
  }
  expect(stored.outbox.filter((row) => row.kind === 'live')).toHaveLength(stored.events.length);
  return { snapshot, stored };
}
