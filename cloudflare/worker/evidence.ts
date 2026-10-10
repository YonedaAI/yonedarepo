import { error, response } from './http';
import { ledger, sha } from './storage';
import type { Env, Json } from './types';

export const EVIDENCE_LIMIT = 8 * 1024 * 1024;
export const CANDIDATE_DIFF_LIMIT = 24 * 1024 * 1024;

/** Call only after binding the digest to an authorized repository ledger record. */
export async function readBoundedEvidence(
  env: Pick<Env, 'OBJECTS'>,
  digest: string,
  limit = EVIDENCE_LIMIT,
) {
  if (!/^[a-f0-9]{64}$/.test(digest)) throw new Error('Invalid object digest');
  const object = await env.OBJECTS.get(`sha256/${digest}`);
  if (!object) throw new Error('Evidence object is missing');
  if (object.size > limit) {
    await object.body.cancel();
    throw new Error('Evidence object exceeds size limit');
  }
  const reader = object.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > limit) {
        await reader.cancel();
        throw new Error('Evidence object exceeds size limit');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  const content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  if ((await sha(content)) !== digest) throw new Error('Evidence digest mismatch');
  return content;
}

// Routes enforce owner/workspace access first; a caller may read only attached digests.
export async function evidence(env: Env, repo: string, digest: string) {
  const snapshot = await ledger(env, repo, { op: 'snapshot' });
  const attached = [
    ...snapshot.artifacts.map((a: Json) => a.digest),
    ...snapshot.executions.map((e: Json) => e.transcript),
    ...snapshot.evaluations.map((e: Json) => e.evidence),
    ...snapshot.candidates.map((c: Json) => c.diff_digest),
  ];
  if (!/^[a-f0-9]{64}$/.test(digest) || !attached.includes(digest))
    return error('NOT_FOUND', 'Evidence is not recorded in this repository', 404);
  const candidateDiff = snapshot.candidates.some(
    (candidate: Json) => candidate.diff_digest === digest,
  );
  return response({
    digest,
    content: await readBoundedEvidence(
      env,
      digest,
      candidateDiff ? CANDIDATE_DIFF_LIMIT : EVIDENCE_LIMIT,
    ),
  });
}
