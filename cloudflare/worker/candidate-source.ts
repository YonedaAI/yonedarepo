import { source } from './artifacts';
import { CANDIDATE_DIFF_LIMIT, readBoundedEvidence } from './evidence';
import { error, response } from './http';
import { ledger } from './storage';
import type { Env, Json } from './types';

/** Owner inspection resolves a recorded candidate, never a caller-supplied revision. */
export async function candidateSource(env: Env, repo: string, id: string) {
  const snapshot = await ledger(env, repo, { op: 'snapshot' });
  const candidate = snapshot.candidates.find((item: Json) => item.id === id);
  if (!candidate) return error('NOT_FOUND', 'Candidate is not recorded in this repository', 404);
  const files = await source(env, candidate.revision);
  const result = response({ candidate_id: candidate.id, revision: candidate.revision, ...files });
  result.headers.set('cache-control', 'no-store');
  return result;
}

/** Owner read boundary only: pass a workspace-authorized ledger snapshot, never job/model JSON.
 * Returns a copy; hydrated source must never flow back into ledger writes or evaluator jobs.
 */
export async function hydrateOwnerSnapshot(env: Env, snapshot: Json): Promise<Json> {
  const candidates = [];
  // Sequential reads bound transient R2 buffering when a repository has many candidates.
  for (const candidate of snapshot.candidates ?? []) {
    candidates.push(await hydrateCandidateDiff(env, candidate));
  }
  return { ...snapshot, candidates };
}

/** Resolve a candidate ID from the owner-authorized repository before reading its diff. */
export async function candidateDetail(env: Env, repo: string, id: string) {
  const snapshot = await ledger(env, repo, { op: 'snapshot' });
  const candidate = snapshot.candidates.find((item: Json) => item.id === id);
  if (!candidate) return error('NOT_FOUND', 'Candidate is not recorded in this repository', 404);
  return response(await hydrateCandidateDiff(env, candidate));
}

async function hydrateCandidateDiff(env: Env, candidate: Json): Promise<Json> {
  if (candidate.diff_digest == null) return candidate; // Pre-migration inline diffs stay readable.
  return {
    ...candidate,
    diff: await readBoundedEvidence(env, candidate.diff_digest, CANDIDATE_DIFF_LIMIT),
  };
}
