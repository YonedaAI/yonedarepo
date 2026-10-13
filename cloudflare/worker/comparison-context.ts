import { source } from './artifacts';
import { canonicalJson } from './canonical-json';
import { assertComparisonReview } from './comparison-scope';
import { CANDIDATE_DIFF_LIMIT, readBoundedEvidence } from './evidence';
import { ledger, sha } from './storage';
import type { Env, Json, Scope } from './types';

const fail = (message: string) => Object.assign(new Error(message), { code: 'FORBIDDEN' });

export const comparisonManifestFingerprint = (manifest: Json) =>
  sha(`yonedarepo:json:v1\0${canonicalJson(manifest)}`);

/** Every selector is checked against the current native manifest and frozen attempt. */
export async function comparisonContext(env: Env, scope: Scope, args: Json = {}): Promise<Json> {
  const frozen = assertComparisonReview(scope.job);
  const result = await ledger(env, scope.repo_id, {
    op: 'comparison_context',
    job_id: scope.job.id,
    epoch: scope.job.epoch,
  });
  if (
    result.approval_id !== frozen.approval_id ||
    result.manifest_digest !== frozen.manifest_digest ||
    canonicalJson(result.manifest) !== canonicalJson(frozen.manifest) ||
    (await comparisonManifestFingerprint(result.manifest)) !== frozen.manifest_digest
  )
    throw fail('Comparison manifest changed; this review attempt is fenced');
  if (
    Object.keys(args).some(
      (key) => !['candidate_id', 'path', 'digest', 'context_id', 'offset', 'limit'].includes(key),
    )
  )
    throw fail('Unknown comparison read selector');
  if (args.context_id !== undefined) {
    const records = scope.job.payload.run.comparison.approval.context;
    if (!Array.isArray(records) || !records.includes(args.context_id))
      throw fail('Context is outside the frozen comparison approval');
    const record = await ledger(env, scope.repo_id, {
      op: 'context_get',
      job_id: scope.job.id,
      epoch: scope.job.epoch,
      id: args.context_id,
    });
    return { manifest_digest: result.manifest_digest, record };
  }
  const candidate =
    args.candidate_id === undefined
      ? undefined
      : result.manifest.candidates?.find(
          (candidate: Json) => candidate.candidate_id === args.candidate_id,
        );
  if (args.candidate_id !== undefined && !candidate)
    throw fail('Candidate is outside the comparison manifest');
  if (args.path !== undefined) {
    if (!candidate) throw fail('Select a captured comparison candidate before reading source');
    const captured = await capturedCandidate(env, scope, candidate);
    return {
      candidate_id: captured.id,
      revision: captured.revision,
      manifest_digest: result.manifest_digest,
      ...(await sourceFile(env, captured, args.path, args.offset, args.limit)),
    };
  }
  if (args.digest !== undefined) {
    const allowed = result.manifest.alternatives.flatMap(
      (alternative: Json) => alternative.evidence_refs ?? [],
    );
    for (const candidate of result.manifest.candidates ?? []) {
      allowed.push(...[candidate.diff_digest, candidate.evaluation?.evidence].filter(Boolean));
    }
    if (typeof args.digest !== 'string' || !allowed.includes(args.digest))
      throw fail('Evidence is outside the comparison manifest');
    const content = await readBoundedEvidence(env, args.digest, CANDIDATE_DIFF_LIMIT);
    return {
      manifest_digest: result.manifest_digest,
      digest: args.digest,
      ...page(new TextEncoder().encode(content), args.offset, args.limit),
    };
  }
  return result;
}

function page(bytes: Uint8Array, offset = 0, limit = 32768) {
  if (
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    offset > bytes.length ||
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > 65536
  )
    throw fail('Invalid bounded source page');
  const end = Math.min(bytes.length, offset + limit);
  const chunk = bytes.subarray(offset, end);
  let content: string;
  let encoding = 'utf8';
  try {
    content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(chunk);
  } catch {
    encoding = 'base64';
    content = btoa(Array.from(chunk, (byte) => String.fromCharCode(byte)).join(''));
  }
  return {
    content,
    encoding,
    offset,
    total_bytes: bytes.length,
    truncated: end < bytes.length,
    next_offset: end < bytes.length ? end : null,
  };
}

async function sourceFile(
  env: Env,
  candidate: Json,
  path: unknown,
  offset?: number,
  limit?: number,
) {
  if (
    typeof path !== 'string' ||
    path.length > 512 ||
    /[\\\0:]/.test(path) ||
    path.split('/').some((part) => !part || ['.', '..', '.git'].includes(part.toLowerCase()))
  )
    throw fail('Invalid captured source path');
  const [namespace, name, extra] = String(candidate.revision?.repository).split('/');
  if (extra || namespace !== env.ARTIFACTS_NAMESPACE || !/^[A-Za-z0-9_.-]{1,100}$/.test(name))
    throw fail('Captured source is outside this namespace');
  using repo = await env.ARTIFACTS.get(name);
  const commit = await repo.readCommit(candidate.revision.commit);
  if (!commit || typeof candidate.tree !== 'string' || commit.treeHash !== candidate.tree)
    throw fail('Captured source tree differs from the comparison manifest');
  let hash = commit.treeHash;
  const parts = path.split('/');
  for (let index = 0; index < parts.length; index++) {
    const entry = (await repo.readTree(hash))?.find((entry) => entry.name === parts[index]);
    if (!entry) throw fail('Captured source path is missing');
    if (index !== parts.length - 1) {
      if (entry.type !== 'tree') throw fail('Source path must traverse regular directories');
      hash = entry.hash;
    } else {
      if (!['blob', 'exec'].includes(entry.type))
        throw fail('Only captured regular files are readable');
      const blob = await repo.readBlob(entry.hash);
      if (!blob || blob.size > 32000000) throw fail('Captured source blob exceeds limits');
      return {
        path,
        blob_digest: entry.hash,
        executable: entry.type === 'exec',
        ...page(new Uint8Array(await blob.arrayBuffer()), offset, limit),
      };
    }
  }
  throw fail('Captured source path is missing');
}

/** Supervisor-only materialization is separate from bounded model tool responses. */
export async function comparisonSources(env: Env, scope: Scope) {
  const context = await comparisonContext(env, scope);
  const candidates = [];
  for (const alternative of context.manifest.alternatives) {
    if (alternative.candidate_id == null) continue;
    const metadata = context.manifest.candidates.find(
      (candidate: Json) => candidate.candidate_id === alternative.candidate_id,
    );
    if (!metadata || canonicalJson(metadata.revision) !== canonicalJson(alternative.revision))
      throw fail('Comparison source identity differs from its frozen alternative');
    const candidate = await capturedCandidate(env, scope, metadata);
    candidates.push({
      candidate_id: candidate.id,
      revision: candidate.revision,
      ...(await source(env, candidate.revision, candidate.tree, {
        bytes: 100 * 1024 * 1024,
        files: 10000,
      })),
    });
  }
  return { manifest_digest: context.manifest_digest, candidates };
}

async function capturedCandidate(env: Env, scope: Scope, metadata: Json): Promise<Json> {
  const candidate = await ledger(env, scope.repo_id, {
    op: 'candidate_record',
    id: metadata.candidate_id,
  });
  if (
    candidate.id !== metadata.candidate_id ||
    candidate.run_id !== scope.job.payload.execution.run_id ||
    canonicalJson(candidate.revision) !== canonicalJson(metadata.revision) ||
    (candidate.diff_digest ?? null) !== (metadata.diff_digest ?? null) ||
    typeof candidate.tree !== 'string'
  )
    throw fail('Captured record differs from the approved comparison revision');
  return candidate;
}
