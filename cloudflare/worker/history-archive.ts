import { ledger } from './storage';
import type { Env, Json } from './types';

const digest = async (content: string) => {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(content));
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
};

/** Upload terminal history before acknowledging the ledger receipt; retries safely overwrite the same key. */
export async function archiveDueHistory(env: Env, repo: string, now = Date.now()): Promise<Json[]> {
  const { run_ids } = await ledger(env, repo, { op: 'archive_candidates', now });
  const receipts: Json[] = [];
  for (const run_id of run_ids as string[]) {
    const prepared = await ledger(env, repo, { op: 'archive_prepare', run_id, now });
    const { job, bundle } = prepared;
    const body = JSON.stringify(bundle);
    const actual = await digest(body);
    if (actual !== job.digest) throw new Error(`Prepared history digest mismatch for ${run_id}`);
    await env.OBJECTS.put(job.object_key, body, {
      httpMetadata: { contentType: 'application/json' },
    });
    const stored = await env.OBJECTS.get(job.object_key);
    if (!stored) throw new Error(`Archive object missing after upload for ${run_id}`);
    const storedBody = await stored.text();
    if ((await digest(storedBody)) !== job.digest)
      throw new Error(`Stored history digest mismatch for ${run_id}`);
    const receipt = await ledger(env, repo, {
      op: 'archive_commit',
      job_id: job.id,
      digest: job.digest,
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
