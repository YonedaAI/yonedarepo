import { CANDIDATE_DIFF_LIMIT, readBoundedEvidence } from './evidence';
import { ledger } from './storage';
import type { Env, Json } from './types';

/** Load one digest-bound candidate diff page after the caller authorizes its repository. */
export async function candidateDiffPage(
  env: Env,
  repo: string,
  run_id: string,
  candidate_id: string,
  cursor?: string,
  limit = 50,
  watermark?: string,
): Promise<Json> {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200)
    throw new Error('Diff page limit must be between 1 and 200');
  const detail = await ledger(env, repo, { op: 'run_detail', run_id });
  const candidate = (detail.candidates as Json[]).find((item) => item.id === candidate_id);
  if (!candidate?.diff_digest) throw new Error('Candidate diff is not attached to this run');
  if (watermark !== undefined && watermark !== candidate.diff_digest)
    throw new Error('Candidate diff changed between pages');
  const offset = cursor === undefined ? 0 : Number(cursor);
  if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('Invalid diff cursor');
  const content = await readBoundedEvidence(env, candidate.diff_digest, CANDIDATE_DIFF_LIMIT);
  const lines = content.split('\n');
  const items = lines.slice(offset, offset + limit);
  const next = offset + items.length;
  return {
    items,
    next_cursor: next < lines.length ? String(next) : null,
    watermark: candidate.diff_digest,
    has_more: next < lines.length,
  };
}
