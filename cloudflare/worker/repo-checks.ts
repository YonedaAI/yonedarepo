// Platform check runs: queue messages carry only (repo, run id). The consumer claims the
// run from the SourceRepository authority with a fenced epoch, then either ships the exact
// commit's files to a fresh CheckContainer, which runs the check and completes the run on
// its own (keeping the output tail in R2), or, for a model runner, makes one review call on
// the commit's diff and completes the run itself.
import type { CheckJob } from './check-container';
import { capacityUnavailable } from './container-capacity';
import { transient } from './durable';
import { replay } from './repo-commit';
import { dispatchHooks } from './repo-hooks';
import { modelCheck } from './repo-model-check';
import { parseStore, RepoObjects } from './repo-objects';
import { type Call, caller, type Json, RepoContext } from './repo-ops';
import { checkFiles } from './repo-seed';
import type { Env, Envelope } from './types';

/** A claimed run as its executor reports it: the run and the evidence gathered so far. */
export type CheckReport = { repo: string; run: Json; evidence: Json };

/** Seconds before a run that found no free container slot is looked at again. */
const CAPACITY_RETRY_SECONDS = 5;
/** Seconds before a claim that met an overloaded authority is tried again. */
const OVERLOAD_RETRY_SECONDS = 10;
/** The longest delay a queue message can carry. */
const MAX_DELAY_SECONDS = 12 * 60 * 60;

/** Start (90 s port wait), the check's own timeout, and a margin for shipping results. */
export const executorDeadlineMs = (timeoutSeconds: number) => (90 + timeoutSeconds + 60) * 1000;

/** `work`, or a CHECK_TIMEOUT failure after `ms` (running `onTimeout` first). */
export function withDeadline<T>(work: Promise<T>, ms: number, onTimeout: () => Promise<unknown>) {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(async () => {
      await onTimeout();
      reject(
        Object.assign(new Error(`Check executor did not finish within ${ms / 1000} s`), {
          code: 'CHECK_TIMEOUT',
        }),
      );
    }, ms);
  });
  return Promise.race([work, expired]).finally(() => timer && clearTimeout(timer));
}

export async function dispatchRuns(env: Env, repo: string, runs: Json[] | undefined) {
  // Re-sending a still-queued run is safe (claims are fenced) and recovers a lost message.
  const queued = (runs ?? []).filter((r) => r.status === 'queued');
  if (queued.length === 0) return;
  await (env.PLATFORM_CHECKS ?? env.PLATFORM_QUEUE).sendBatch(
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

/** The commit and tree a claimed run checks, as its evidence must name them. */
const ranOn = (run: Json) => ({ commit: run.commit, tree: run.tree });

/** The files and starting evidence of a claimed command check, ready for its container. */
async function containerJob(env: Env, repo: string, call: Call, run: Json) {
  const status = await call({ op: 'repo_status' });
  const objects = new RepoObjects(env, repo, parseStore(env, status.object_store)).withhold(
    status.quarantined,
  );
  // A runner's sparse scope: only its paths are read and shipped (none: the whole tree).
  const scope: string[] | undefined = run.paths?.length ? run.paths : undefined;
  const shipped = await checkFiles(env, repo, objects, run.tree, 'main', scope);
  const job: CheckJob = {
    command: run.command,
    timeout_seconds: run.timeout_seconds,
    files: shipped.files,
  };
  const evidence: Json = {
    // What ran: the authority refuses a verdict whose evidence names another commit, tree
    // or no file set.
    ...ranOn(run),
    // The digest covers exactly the scoped listing that shipped.
    files_sha256: shipped.files_sha256,
    ...(scope ? { scope } : {}),
    queued_ms: run.queued_ms,
    shipped_bytes: shipped.bytes,
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
  };
  return { job, evidence };
}

/** Completes a container check from its executor's result (the CheckContainer calls this). */
export async function completeContainerCheck(env: Env, report: CheckReport, result: Json) {
  const { repo, run } = report;
  const log = `platform/v1/${repo}/checks/${run.run_id}/${run.epoch}.log`;
  await env.OBJECTS.put(log, String(result.output_tail ?? ''), {
    customMetadata: { sha256: String(result.output_sha256 ?? ''), commit: run.commit },
  });
  const evidence: Json = {
    exit_code: result.exit_code ?? null,
    timed_out: result.timed_out === true,
    duration_ms: result.duration_ms,
    start_ms: result.start_ms,
    // Billed container time before the command ran: receiving and writing the files.
    ...(typeof result.setup_ms === 'number' ? { setup_ms: result.setup_ms } : {}),
    output_bytes: result.output_bytes,
    output_sha256: result.output_sha256,
    log,
    ...report.evidence,
  };
  await settle(env, report, result.outcome === 'pass' ? 'pass' : 'fail', evidence);
}

/** Records an executor failure: an error outcome, which records no check and can re-run. */
export async function failCheckRun(env: Env, report: CheckReport, e: any) {
  const errored = await complete(env, report, 'error', {
    error: String(e?.message ?? e).slice(0, 500),
    code: e?.code ?? 'CHECK_EXECUTOR',
  });
  if (errored.hooks) await dispatchHooks(env, report.repo).catch(() => {});
}

const complete = (env: Env, { repo, run }: CheckReport, outcome: string, evidence: Json) =>
  caller(env, repo, { _system: 'checks' })({
    op: 'repo_check_complete',
    run_id: run.run_id,
    epoch: run.epoch,
    outcome,
    evidence,
  });

/** Completes a run with its verdict, then what the verdict starts: webhooks, repair
 * proposals for a post-land failure, and the next step of bisects waiting on it. */
async function settle(env: Env, report: CheckReport, outcome: string, evidence: Json) {
  const { repo, run } = report;
  try {
    const completed = await complete(env, report, outcome, evidence);
    if (completed.hooks) await dispatchHooks(env, repo).catch(() => {});
    await proposeRepairs(env, repo, run, completed.repair ?? []);
    const call = caller(env, repo, { _system: 'checks' });
    for (const id of (completed.bisects ?? []) as string[]) {
      const step = await call({ op: 'repo_bisect_step', id });
      await dispatchRuns(env, repo, step.runs);
    }
  } catch (e) {
    await failCheckRun(env, report, e);
  }
}

/** Delivers `envelope` again after `seconds` as a fresh message. Unlike a retry it never
 * counts toward the queue's max_retries, so waiting cannot drop a run into the DLQ. */
async function later(env: Env, envelope: Envelope, seconds: number) {
  const delaySeconds = Math.min(MAX_DELAY_SECONDS, Math.max(1, Math.ceil(seconds)));
  await (env.PLATFORM_CHECKS ?? env.PLATFORM_QUEUE).send(envelope, { delaySeconds });
}

/**
 * Claims a queued run and starts it. A command check is handed to its CheckContainer,
 * which completes the run itself, so this returns once the container is up and the
 * consumer is free for the next run; a model check (one bounded call) runs here. A run
 * that cannot start yet comes back as a fresh delayed message: held by another executor
 * (until its lease lapses), no free container slot (the claim is given back, spending no
 * attempt), or an overloaded authority.
 */
export async function executeCheckRun(env: Env, envelope: Envelope): Promise<void> {
  const repo = envelope.repo_id;
  const call = caller(env, repo, { _system: 'checks' });
  let run: Json;
  try {
    run = await call({ op: 'repo_check_claim', run_id: envelope.job_id });
  } catch (e) {
    if (transient(e)) return later(env, envelope, OVERLOAD_RETRY_SECONDS);
    throw e;
  }
  if (run.done) return;
  if (run.busy) return later(env, envelope, run.retry_after_ms / 1000);
  const report: CheckReport = { repo, run, evidence: {} };
  if (run.kind === 'model') {
    try {
      const { outcome, evidence } = await modelCheck(env, new RepoContext(env, repo, call), run);
      await settle(env, report, outcome, { ...evidence, ...ranOn(run) });
    } catch (e) {
      await failCheckRun(env, report, e);
    }
    return;
  }
  try {
    const { job, evidence } = await containerJob(env, repo, call, run);
    const executor = env.CHECK_RUNNERS.get(
      env.CHECK_RUNNERS.idFromName(`${run.run_id}:${run.epoch}`),
    );
    await executor.launch(job, { ...report, evidence });
  } catch (e) {
    if (!capacityUnavailable(e)) return failCheckRun(env, report, e);
    await call({ op: 'repo_check_release', run_id: run.run_id, epoch: run.epoch });
    return later(env, envelope, CAPACITY_RETRY_SECONDS);
  }
  // The watchdog: should the executor die mid-run, this message finds the lease lapsed
  // and claims the run again (a finished run makes it a no-op).
  await later(env, envelope, (run.lease_until - Date.now()) / 1000 + 5);
}
