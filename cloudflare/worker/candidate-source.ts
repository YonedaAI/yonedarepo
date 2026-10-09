import { source } from './artifacts';
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
