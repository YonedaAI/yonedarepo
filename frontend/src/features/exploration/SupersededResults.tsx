import { short } from '../../lib/api';
import type { Snapshot } from '../../lib/types';
import { rejectionOf } from './agentsPick';

/** Earlier results stay inspectable as history but are not offered for publication. */
export function SupersededResults({
  snapshot,
  results,
}: {
  snapshot: Snapshot;
  results: Record<string, any>[];
}) {
  if (!results.length) return null;
  return (
    <details className="superseded-results">
      <summary>Earlier results (superseded) · {results.length}</summary>
      <ul>
        {results.map((candidate) => {
          const evaluation = snapshot.evaluations.find((item) => item.id === candidate.evaluation);
          const checks: Record<string, any>[] = evaluation?.checks ?? [];
          const rejection = rejectionOf(snapshot, candidate);
          return (
            <li key={candidate.id} id={`result-${candidate.id}`} tabIndex={-1}>
              <code>{short(candidate.revision?.commit)}</code>{' '}
              {candidate.conflict_id ? 'Reconciled result' : 'Integrated result'} ·{' '}
              {rejection
                ? 'rejected by you'
                : (candidate.status ?? 'recorded').replaceAll('_', ' ')}
              {checks.length > 0 &&
                ` · ${checks.filter((check) => check.status === 'pass').length}/${checks.length} checks passed`}
              {rejection?.reason && <p>Your reason: {rejection.reason}</p>}
            </li>
          );
        })}
      </ul>
    </details>
  );
}
