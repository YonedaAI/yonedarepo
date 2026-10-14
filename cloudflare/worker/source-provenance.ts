import { sourceFingerprint } from './source-crypto';
import { sourcePath } from './source-path';
import { ledger } from './storage';
import type { Env, Json } from './types';

/** Ask native file lineage at the server-resolved immutable revision, never infer it from existence. */
export async function sourceProvenance(
  env: Env,
  repo: string,
  commit: string,
  path: string,
  candidate: Json | null,
) {
  sourcePath(path);
  const why = await ledger(env, repo, { op: 'why', commit, path });
  const lineage = Array.isArray(why.lineage) ? why.lineage.slice(0, 128) : [];
  const coverage = why.coverage === 'recorded' && lineage.length ? 'recorded' : 'unknown';
  let evaluation: Json | null = null;
  if (candidate && typeof candidate.evaluation === 'string') {
    const stored = await ledger(env, repo, { op: 'evaluation_record', id: candidate.evaluation });
    if (
      stored.id === candidate.evaluation &&
      stored.candidate === candidate.id &&
      (await sourceFingerprint(stored.revision)) === (await sourceFingerprint(candidate.revision))
    )
      evaluation = stored;
  }
  return {
    path,
    coverage,
    provenance_authority: 'recorded_file_provenance',
    explanation:
      coverage === 'recorded'
        ? 'Trusted capture lineage records this file at the selected revision.'
        : 'No recorded file lineage explains this path at the selected revision.',
    checks: (evaluation?.checks ?? []).filter(
      (check: Json) =>
        typeof check.name === 'string' && ['pass', 'fail', 'pending'].includes(check.status),
    ),
    evaluation: evaluation
      ? {
          id: evaluation.id,
          revision: evaluation.revision,
          policy: evaluation.policy,
          suite: evaluation.suite,
          environment: evaluation.environment,
          evidence: evaluation.evidence,
          authority: 'historical_checked_revision',
        }
      : null,
    risks: [],
    context: [],
    revisions: lineage
      .filter(
        (entry: Json) =>
          typeof entry.candidate === 'string' &&
          typeof entry.revision?.repository === 'string' &&
          typeof entry.revision?.commit === 'string',
      )
      .map((entry: Json) => ({
        candidate_id: entry.candidate,
        revision: entry.revision,
        label: entry.change ?? 'capture',
      })),
    lineage,
    decisions: why.decisions ?? [],
    rejected_alternatives: why.rejected_alternatives ?? [],
    bounded: true,
    truncated: why.truncated === true,
    recorded_candidate_id: candidate?.id ?? null,
  };
}
