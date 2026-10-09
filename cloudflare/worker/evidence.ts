import { error, response } from './http';
import { ledger, readObject } from './storage';
import type { Env, Json } from './types';
// An owner can read only digests already attached to this repository's ledger.
export async function evidence(env: Env, repo: string, digest: string) {
  const snapshot = await ledger(env, repo, { op: 'snapshot' });
  const attached = [
    ...snapshot.artifacts.map((a: Json) => a.digest),
    ...snapshot.executions.map((e: Json) => e.transcript),
    ...snapshot.evaluations.map((e: Json) => e.evidence),
  ];
  if (!attached.includes(digest))
    return error('NOT_FOUND', 'Evidence is not recorded in this repository', 404);
  return response({ digest, content: await readObject(env, digest) });
}
