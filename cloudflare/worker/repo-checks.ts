// Platform check runs: queue messages carry only (repo, run id). The consumer claims the
// run from the SourceRepository authority with a fenced epoch, ships the exact commit's
// files to a fresh CheckContainer, keeps the output tail in R2 and completes the run.
import type { CheckJob } from './check-container';
import { parseStore, RepoObjects } from './repo-objects';
import { caller, type Json, RepoContext, replay } from './repo-ops';
import { checkFiles } from './repo-seed';
import type { Env, Envelope } from './types';

export async function dispatchRuns(env: Env, repo: string, runs: Json[] | undefined) {
  // Re-sending a still-queued run is safe (claims are fenced) and recovers a lost message.
  const queued = (runs ?? []).filter((r) => r.status === 'queued');
  if (queued.length === 0) return;
  await env.PLATFORM_QUEUE.sendBatch(
    queued.map((run) => ({
      body: { v: 1, kind: 'platform_check', repo_id: repo, job_id: String(run.id) } as Envelope,
    })),
  );
}

/**
 * A check failed on work that already landed: propose a revert of it on each branch as a
 * repair commit (recorded, not landed; it goes through its own checks and review).
 */
async function proposeRepairs(env: Env, repo: string, run: Json, refs: string[]) {
  const call = caller(env, repo, { _system: 'checks' });
  const repairer = new RepoContext(env, repo, caller(env, repo, { _system: 'repair' }));
  for (const refname of refs) {
    const link = { op: 'repo_record_repair', commit: run.commit, refname, check: run.name };
    try {
      const made = await replay(
        repairer,
        {
          commit: run.commit,
          ref: refname,
          message: `Revert ${String(run.commit).slice(0, 10)}: post-land check ${run.name} failed\n\nRepair proposed by YonedaRepo for commit ${run.commit}.`,
        },
        'revert',
      );
      await call({ ...link, repair_commit: made.commit });
    } catch (e: any) {
      await call({ ...link, error: `${e?.code ?? 'ERROR'}: ${e?.message ?? e}` });
    }
  }
}

/** Returns `retry` with a delay when another executor still holds the run's lease. */
export async function executeCheckRun(env: Env, envelope: Envelope): Promise<{ retry?: number }> {
  const repo = envelope.repo_id;
  const call = caller(env, repo, { _system: 'checks' });
  const run = await call({ op: 'repo_check_claim', run_id: envelope.job_id });
  if (run.done) return {};
  if (run.busy) return { retry: Math.ceil(run.retry_after_ms / 1000) };
  const complete = (outcome: string, evidence: Json) =>
    call({ op: 'repo_check_complete', run_id: run.run_id, epoch: run.epoch, outcome, evidence });
  try {
    const status = await call({ op: 'repo_status' });
    const objects = new RepoObjects(env, repo, parseStore(env, status.object_store));
    const shipped = await checkFiles(env, repo, objects, run.tree);
    const job: CheckJob = {
      command: run.command,
      timeout_seconds: run.timeout_seconds,
      files: shipped.files,
    };
    const executor = env.CHECK_RUNNERS.get(
      env.CHECK_RUNNERS.idFromName(`${run.run_id}:${run.epoch}`),
    );
    const result = (await executor.run(job)) as Json;
    const log = `platform/v1/${repo}/checks/${run.run_id}/${run.epoch}.log`;
    await env.OBJECTS.put(log, String(result.output_tail ?? ''), {
      customMetadata: { sha256: String(result.output_sha256 ?? ''), commit: run.commit },
    });
    const completed = await complete(result.outcome === 'pass' ? 'pass' : 'fail', {
      exit_code: result.exit_code ?? null,
      timed_out: result.timed_out === true,
      duration_ms: result.duration_ms,
      output_bytes: result.output_bytes,
      output_sha256: result.output_sha256,
      log,
      // Files came from the branch's warm-start seed plus this many fetched blobs.
      ...(shipped.seed ? { seed: shipped.seed } : {}),
      // Per-tier counts for S12: files served by the seed (the executor's warm tier; its
      // containers are single-use, so nothing is cached inside them), then object reads
      // served by the edge Cache API, R2 and the object store.
      tiers: {
        seed: shipped.seed ? shipped.files.length - shipped.seed.fetched : 0,
        files: shipped.files.length,
        ...objects.hits,
      },
    });
    await proposeRepairs(env, repo, run, completed.repair ?? []);
    // Advance bisects that were waiting on this result (and queue their next run).
    for (const id of (completed.bisects ?? []) as string[]) {
      const step = await call({ op: 'repo_bisect_step', id });
      await dispatchRuns(env, repo, step.runs);
    }
  } catch (e: any) {
    await complete('error', {
      error: String(e?.message ?? e).slice(0, 500),
      code: e?.code ?? 'CHECK_EXECUTOR',
    });
  }
  return {};
}
