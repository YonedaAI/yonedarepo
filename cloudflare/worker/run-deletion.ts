import { projectPlatform } from './agents-platform';
import { failureCode, writeLog } from './logging';
import { runSegment } from './sandbox-team';
import type { Env, Json } from './types';

/** The platform refuses ref batches larger than this. */
const REF_BATCH = 100;

/**
 * Cleanup after the ledger deleted a run: its archived history (retried until R2 accepts the
 * delete) and its `attempts/<run>/…` branches. Branch cleanup is best effort with the project's
 * agent token, so a revoked token or unbound project never stalls the outbox behind it.
 */
export async function deliverRunDeletion(env: Env, repo: string, entry: Json) {
  const { run_id, workspace, archive_key } = entry.payload;
  if (typeof run_id !== 'string' || archive_key !== `history/${repo}/${run_id}.json`)
    throw new Error('Run deletion identity mismatch');
  await env.OBJECTS.delete(archive_key);
  try {
    const platform = await projectPlatform(env, String(workspace), repo);
    const prefix = `refs/heads/attempts/${await runSegment(run_id)}/`;
    const { refs } = await platform.call('GET', '/refs');
    const updates = Object.entries(refs as Record<string, string>)
      .filter(([ref]) => ref.startsWith(prefix))
      .map(([ref, commit]) => ({ ref, commit: null, expected: commit }));
    for (let at = 0; at < updates.length; at += REF_BATCH)
      await platform.call('POST', '/refs/batch', { updates: updates.slice(at, at + REF_BATCH) });
  } catch (error) {
    writeLog('run.branch_cleanup_failed', {
      repo_id: repo,
      run_id,
      error_code: failureCode(error),
    });
  }
}
