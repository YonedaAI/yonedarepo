// Platform check runs: queue messages carry only (repo, run id). The consumer claims the
// run from the SourceRepository authority with a fenced epoch, ships the exact commit's
// files to a fresh CheckContainer, keeps the output tail in R2 and completes the run.
import type { CheckJob } from './check-container';
import { parseStore, RepoObjects, type TreeEntry, toBase64 } from './repo-objects';
import { caller, type Json } from './repo-ops';
import type { Env, Envelope } from './types';

const MAX_FILES = 100_000;
const MAX_BYTES = 192 * 1024 * 1024;

export async function dispatchRuns(env: Env, repo: string, runs: Json[] | undefined) {
  const queued = (runs ?? []).filter((r) => r.status === 'queued' && !r.existing);
  if (queued.length === 0) return;
  await env.PLATFORM_QUEUE.sendBatch(
    queued.map((run) => ({
      body: { v: 1, kind: 'platform_check', repo_id: repo, job_id: String(run.id) } as Envelope,
    })),
  );
}

async function files(objects: RepoObjects, tree: string) {
  const out: CheckJob['files'] = [];
  let bytes = 0;
  const visit = async (id: string, prefix: string) => {
    const entries: TreeEntry[] = await objects.tree(id);
    for (const entry of entries) {
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.type === 'tree') await visit(entry.id, path);
      else if (entry.type !== 'gitlink') {
        const data = await objects.blob(entry.id);
        bytes += data.length;
        if (out.length >= MAX_FILES || bytes > MAX_BYTES)
          throw Object.assign(new Error('Commit is too large for a platform check'), {
            code: 'TOO_LARGE',
          });
        out.push({ path, type: entry.type, data_b64: toBase64(data) });
      }
    }
  };
  await visit(tree, '');
  return out;
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
    const job: CheckJob = {
      command: run.command,
      timeout_seconds: run.timeout_seconds,
      files: await files(objects, run.tree),
    };
    const executor = env.CHECK_RUNNERS.get(
      env.CHECK_RUNNERS.idFromName(`${run.run_id}:${run.epoch}`),
    );
    const result = (await executor.run(job)) as Json;
    const log = `platform/v1/${repo}/checks/${run.run_id}/${run.epoch}.log`;
    await env.OBJECTS.put(log, String(result.output_tail ?? ''), {
      customMetadata: { sha256: String(result.output_sha256 ?? ''), commit: run.commit },
    });
    await complete(result.outcome === 'pass' ? 'pass' : 'fail', {
      exit_code: result.exit_code ?? null,
      timed_out: result.timed_out === true,
      duration_ms: result.duration_ms,
      output_bytes: result.output_bytes,
      output_sha256: result.output_sha256,
      log,
    });
  } catch (e: any) {
    await complete('error', {
      error: String(e?.message ?? e).slice(0, 500),
      code: e?.code ?? 'CHECK_EXECUTOR',
    });
  }
  return {};
}
