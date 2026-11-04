// One keyed run-list read: changing agent clears its rows without reloading workspace names.
import type { ManagedRun } from '../../../../shared/managed-agents';
import { EmptyState } from '../../components/EmptyState';
import { linkTo, type Navigate } from '../shell/useRoute';
import { Loading } from '../source-platform/SourceStatus';
import { shortSha } from '../source-platform/sourceApi';
import { useSource } from '../source-platform/useSource';
import { AgentUsage } from './AgentUsage';
import { loadState, StatusChip } from './agentParts';
import { agentName, formatCost, runDuration, runsPath, tileTone, valueLabel } from './agentsModel';

type Space = { workspace?: string };
function RunsTable({
  runs,
  names,
  space,
  navigate,
}: {
  runs: ManagedRun[];
  names: Map<string, string>;
  space: Space;
  navigate: Navigate;
}) {
  if (!runs.length)
    return (
      <EmptyState title="No runs yet">An agent runs when a Landing opens or is pushed.</EmptyState>
    );
  return (
    <div className="source-table-wrap">
      <table className="source-table agent-runs-table">
        <thead>
          <tr>
            <th>Agent</th>
            <th>Repository</th>
            <th>Change</th>
            <th>Head</th>
            <th>Result</th>
            <th>Model</th>
            <th className="num">Cost</th>
            <th>Duration</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody>
          {runs.map((run) => (
            <tr key={`${run.repo}:${run.id}`}>
              <td>
                <a
                  {...linkTo(
                    { view: 'agent-run', runRepo: run.repo, run: run.id, ...space },
                    navigate,
                  )}
                >
                  {agentName(run.agent)}
                </a>
              </td>
              <td>
                <a {...linkTo({ view: 'overview', repo: run.repo }, navigate)}>
                  {names.get(run.repo) ?? run.repo}
                </a>
              </td>
              <td>
                <a {...linkTo({ view: 'change', repo: run.repo, number: run.change }, navigate)}>
                  #{run.change}
                </a>
              </td>
              <td>
                <code>{shortSha(run.head)}</code>
              </td>
              <td>
                <span className={`chip run-${tileTone(run)}`}>{valueLabel(run.value)}</span>
              </td>
              <td>
                {run.model}
                {run.fallback && (
                  <span className="chip run-warn" title={run.fallback}>
                    fallback
                  </span>
                )}
              </td>
              <td className="num">{formatCost(run.cost_usd)}</td>
              <td>{runDuration(run)}</td>
              <td>
                <StatusChip run={run} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function AgentRunList({
  workspace,
  agent,
  names,
  space,
  navigate,
}: {
  workspace: string;
  agent?: string;
  names: Map<string, string>;
  space: Space;
  navigate: Navigate;
}) {
  const runs = useSource<{ runs: ManagedRun[] }>(runsPath(workspace, { agent }), '/api/managed');
  if (runs.loading && !runs.data && !runs.error)
    return (
      <>
        <AgentUsage runs={[]} loading />
        <Loading what="runs" />
      </>
    );
  return (
    loadState(runs, 'runs') ??
    (runs.data && (
      <>
        <AgentUsage runs={runs.data.runs} />
        <RunsTable runs={runs.data.runs} names={names} space={space} navigate={navigate} />
      </>
    ))
  );
}
