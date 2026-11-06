// Saved retry snapshots are cumulative observations, never extra usage to add to this run.
import type { RunDetail } from '../../../../shared/managed-agents';
import { when } from '../source-platform/sourceApi';
import { StatusChip } from './agentParts';
import { formatCost } from './agentsModel';

export function EarlierAttempts({ attempts }: { attempts: RunDetail['previous_attempts'] }) {
  if (!attempts?.length) return null;
  return (
    <section aria-labelledby="earlier-attempts-heading">
      <h2 id="earlier-attempts-heading">Earlier attempts</h2>
      <p className="source-meta">Costs include earlier attempts.</p>
      {attempts.map(({ attempt, run }) => (
        <section key={attempt} aria-label={`Attempt ${attempt}`}>
          <h3>Attempt {attempt}</h3>
          <dl className="managed-facts">
            <dt>Status</dt>
            <dd>
              <StatusChip run={run} />
            </dd>
            <dt>Model</dt>
            <dd>
              {run.harness} · {run.model}
              {run.fallback && <span className="source-meta"> ({run.fallback})</span>}
            </dd>
            <dt>Finished</dt>
            <dd>{when(run.finished_at ?? undefined) || 'Not recorded'}</dd>
            <dt>Cost so far</dt>
            <dd>{formatCost(run.cost_usd)}</dd>
            {run.error && (
              <>
                <dt>Error</dt>
                <dd>{run.error}</dd>
              </>
            )}
          </dl>
        </section>
      ))}
    </section>
  );
}
