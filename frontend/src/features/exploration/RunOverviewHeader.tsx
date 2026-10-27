import { short } from '../../lib/api';
import { RunIntent } from './RunIntent';
import { runTitle } from './runTitle';

export function RunOverviewHeader({
  run,
  roots,
  subagents,
  previousRun,
  onSelectRun,
}: {
  run: Record<string, any>;
  roots: number;
  subagents: number;
  previousRun?: string;
  onSelectRun: (id: string) => void;
}) {
  return (
    <div className="intent-row">
      <div className="run-heading">
        <h2>{runTitle(run.intent)}</h2>
        <RunIntent intent={String(run.intent ?? '')} />
        {run.criteria?.length > 0 && (
          <details className="review-criteria">
            <summary>Acceptance criteria</summary>
            <ul>
              {run.criteria.map((criterion: string, index: number) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: Frozen criteria may repeat and have no item state.
                <li key={`${index}:${criterion}`}>{criterion}</li>
              ))}
            </ul>
          </details>
        )}
        <div className="run-meta">
          <span>
            Base <code>{short(run.base?.commit)}</code>
          </span>
          <span>
            {run.mode === 'collaborate'
              ? `${run.agents?.length ?? roots} team agents · Build together`
              : run.comparison?.approval
                ? `${roots} builders · automatic reviewer`
                : run.mode === 'compare'
                  ? `${roots} builders · manual comparison`
                  : `${roots} root agents · ${subagents} subagents`}
          </span>
          {previousRun && (
            <button type="button" className="text-button" onClick={() => onSelectRun(previousRun)}>
              {run.continuation_of ? 'View published base' : 'View previous run'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
