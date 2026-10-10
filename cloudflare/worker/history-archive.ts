import { ledger } from './storage';
import type { Env, Json } from './types';

const digest = async (content: string) => {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(content));
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
};

/** Upload exact Rust-serialized history once before acknowledging its ledger receipt. */
export async function archiveDueHistory(env: Env, repo: string, now = Date.now()): Promise<Json[]> {
  const { run_ids } = await ledger(env, repo, { op: 'archive_candidates', now });
  const receipts: Json[] = [];
  for (const run_id of run_ids as string[]) {
    const prepared = await ledger(env, repo, { op: 'archive_prepare', run_id, now });
    const { job, bundle_json } = prepared;
    if (typeof bundle_json !== 'string')
      throw new Error(`Prepared history bytes are missing for ${run_id}`);
    const body = bundle_json;
    const actual = await digest(body);
    if (actual !== job.digest) throw new Error(`Prepared history digest mismatch for ${run_id}`);
    try {
      await env.OBJECTS.put(job.object_key, body, {
        onlyIf: { etagDoesNotMatch: '*' },
        httpMetadata: { contentType: 'application/json' },
      });
    } catch (error) {
      // A prior attempt may have written the immutable key before losing its acknowledgment.
      if (!(await env.OBJECTS.get(job.object_key))) throw error;
    }
    const stored = await env.OBJECTS.get(job.object_key);
    if (!stored) throw new Error(`Archive object missing after upload for ${run_id}`);
    const storedBody = await stored.text();
    if ((await digest(storedBody)) !== job.digest)
      throw new Error(`Stored history digest mismatch for ${run_id}`);
    const receipt = await ledger(env, repo, {
      op: 'archive_commit',
      job_id: job.id,
      digest: job.digest,
      verified_digest: actual,
      receipt_id: `archive-receipt:${run_id}:${job.digest}`,
      now,
    });
    receipts.push(receipt);
  }
  return receipts;
}

/** Route only after repository authorization; archived bytes are digest checked on every read. */
export async function archivedHistoryDetail(env: Env, repo: string, run_id: string): Promise<Json> {
  const index = await ledger(env, repo, { op: 'archive_status', run_id });
  const object = await env.OBJECTS.get(index.object_key);
  if (!object) throw new Error('Archived history object is missing');
  const body = await object.text();
  if ((await digest(body)) !== index.digest)
    throw new Error('Archived history failed digest verification');
  return JSON.parse(body) as Json;
}

/** Preserve the run_detail contract while hydrating compacted history from verified R2 bytes. */
export async function historyDetail(env: Env, repo: string, run_id: string): Promise<Json> {
  const hot = await ledger(env, repo, { op: 'run_detail', run_id });
  if (!hot.archive) return hot;
  const archived = await archivedHistoryDetail(env, repo, run_id);
  return mergeArchivedHistoryDetail(archived, hot, run_id);
}

/** Keep the immutable R2 graph/log snapshot while refreshing fields the ledger may advance later. */
export function mergeArchivedHistoryDetail(archived: Json, hot: Json, run_id: string): Json {
  if (
    archived.run?.id !== run_id ||
    !Array.isArray(archived.runs) ||
    archived.runs.length !== 1 ||
    archived.runs[0].id !== run_id ||
    !Array.isArray(archived.executions) ||
    archived.executions.some((item) => item.run_id !== run_id) ||
    hot.run?.id !== run_id ||
    !Array.isArray(hot.runs) ||
    hot.runs.length !== 1 ||
    hot.runs[0].id !== run_id ||
    !Array.isArray(hot.executions) ||
    hot.executions.some((item) => item.run_id !== run_id)
  ) {
    throw new Error('Archived detail does not match the requested run');
  }
  return {
    ...archived,
    archived_run: archived.run,
    repository: hot.repository,
    run: hot.run,
    runs: hot.runs,
    executions: hot.executions,
    candidates: hot.candidates,
    evaluations: hot.evaluations,
    decisions: hot.decisions,
    team_tasks: hot.team_tasks,
    team_handoffs: hot.team_handoffs,
    artifacts: hot.artifacts,
    archive: hot.archive,
    capabilities: hot.capabilities,
    seq: hot.seq,
  };
}
