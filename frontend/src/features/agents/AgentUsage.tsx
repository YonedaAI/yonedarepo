import type { ManagedRun } from '../../../../shared/managed-agents';
import '../../styles/agent-usage.css';
import { formatCost } from './agentsModel';
import { recordedUsage, usageCount, usageOutcomes, usageTime } from './agentUsageModel';

/** Summarizes only loaded records; no separate request or inferred historical totals. */
export function AgentUsage({
  runs,
  coverage,
  loading = false,
}: {
  runs: ManagedRun[];
  coverage?: string;
  loading?: boolean;
}) {
  if (!runs.length && !loading) return null;
  const u = recordedUsage(runs);
  const missing = runs.length - u.reported;
  const count = `${runs.length} run${runs.length === 1 ? '' : 's'}`;
  const tiles = [
    {
      label: 'Recorded tokens',
      value: u.reported ? usageCount(u.input + u.output) : '—',
      caption: loading
        ? '\u00a0'
        : u.reported
          ? `${usageCount(u.input)} in · ${usageCount(u.output)} out`
          : 'Not reported',
    },
    {
      label: 'Model calls',
      value: u.reported ? usageCount(u.calls) : '—',
      caption: 'With reported usage',
    },
    {
      label: 'Run time',
      value: u.timed ? usageTime(u.seconds) : '—',
      caption:
        !loading && u.timed < runs.length
          ? `Recorded for ${u.timed} of ${count}`
          : 'Recorded execution time',
    },
    {
      label: 'Recorded cost',
      value: u.priced ? formatCost(u.cost) : '—',
      caption:
        !loading && u.priced < runs.length
          ? `Recorded for ${u.priced} of ${count}`
          : 'In these run records',
    },
  ];
  return (
    <section className="agent-usage-summary" aria-label="Agent usage" aria-busy={loading}>
      <div className="agents-toolbar">
        <h2>Usage</h2>
        <span className="source-meta">
          {loading ? 'Loading usage…' : (coverage ?? `Latest ${count}`)}
        </span>
      </div>
      <ul className="stat-cards">
        {tiles.map((tile) => (
          <li className="stat-card" key={tile.label}>
            <span className="stat-label">{tile.label}</span>
            <span className="managed-figure stat-number" aria-hidden={loading}>
              {loading ? '\u00a0' : tile.value}
            </span>
            <span className="stat-caption">{tile.caption}</span>
          </li>
        ))}
      </ul>
      <p className="source-meta" aria-hidden={loading}>
        {loading ? '\u00a0' : usageOutcomes(u.outcomes)}
      </p>
      {missing > 0 && (
        <p className="source-meta">
          Tokens not reported for {missing} run{missing === 1 ? '' : 's'}.
        </p>
      )}
    </section>
  );
}
