// Agents → View runs (`/agents/runs`): every run across the workspace's agents with its result,
// model, cost, duration and status, filtered by agent; and one run's detail
// (`/agents/runs/<repo>/<run>`): its findings, the harness CLI's transcript and the cost
// breakdown (model calls and container time).
import type { ManagedRun, RunDetail, WorkspaceState } from '../../../../shared/managed-agents';
import { MANAGED_AGENTS } from '../../../../shared/managed-agents';
import { linkTo, type Navigate } from '../shell/useRoute';
import { shortSha, when } from '../source-platform/sourceApi';
import { useSource } from '../source-platform/useSource';
import { loadState, StatusChip } from './agentParts';
import {
  agentName,
  costLabel,
  costUsd,
  formatCost,
  runDuration,
  runPath,
  runsPath,
  tileTone,
  valueLabel,
  workspacePath,
} from './agentsModel';

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
      <p className="source-empty">
        No runs yet. An enabled agent runs when a change opens or is pushed.
      </p>
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
            <th>Cost</th>
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
                <a {...linkTo({ view: 'files', repo: run.repo, path: '', ref: 'main' }, navigate)}>
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
              <td>{formatCost(run.cost_usd)}</td>
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

export function AgentRuns({
  workspace,
  agent,
  space,
  navigate,
}: {
  workspace: string;
  agent?: string;
  space: Space;
  navigate: Navigate;
}) {
  const runs = useSource<{ runs: ManagedRun[] }>(runsPath(workspace, { agent }), '/api/managed');
  const state = useSource<WorkspaceState>(workspacePath(workspace), '/api/managed');
  const names = new Map((state.data?.repos ?? []).map((r) => [r.id, r.name]));
  return (
    <div className="agents-page">
      <div className="agents-toolbar">
        <h1 className="agents-heading">Runs</h1>
        <nav className="segmented agent-run-filter" aria-label="Filter runs by agent">
          <a
            aria-current={!agent ? 'page' : undefined}
            {...linkTo({ view: 'agent-runs', ...space }, navigate)}
          >
            All agents
          </a>
          {MANAGED_AGENTS.map((a) => (
            <a
              key={a.id}
              aria-current={agent === a.id ? 'page' : undefined}
              {...linkTo({ view: 'agent-runs', agent: a.id, ...space }, navigate)}
            >
              {a.defaults.name}
            </a>
          ))}
        </nav>
      </div>
      {loadState(runs, 'runs') ??
        (runs.data && (
          <RunsTable runs={runs.data.runs} names={names} space={space} navigate={navigate} />
        ))}
      <a {...linkTo({ view: 'agents-home', ...space }, navigate)}>Back to agents</a>
    </div>
  );
}

export function AgentRunDetail({
  workspace,
  repo,
  run,
  space,
  navigate,
}: {
  workspace: string;
  repo: string;
  run: string;
  space: Space;
  navigate: Navigate;
}) {
  const loaded = useSource<RunDetail>(runPath(workspace, repo, run), '/api/managed');
  const detail = loaded.data;
  return (
    <div className="agents-page agent-run-detail">
      {loadState(loaded, 'the run') ??
        (detail && (
          <>
            <h1 className="agents-heading">
              {agentName(detail.run.agent)} on change #{detail.run.change}
            </h1>
            <dl className="managed-facts">
              <dt>Result</dt>
              <dd>
                <span className={`chip run-${tileTone(detail.run)}`}>
                  {valueLabel(detail.run.value)}
                </span>{' '}
                <StatusChip run={detail.run} />
              </dd>
              <dt>Head</dt>
              <dd>
                <a {...linkTo({ view: 'commit', repo, commit: detail.run.head }, navigate)}>
                  <code>{shortSha(detail.run.head)}</code>
                </a>
              </dd>
              <dt>Harness</dt>
              <dd>
                {detail.run.harness} · {detail.run.model}
                {detail.run.fallback && (
                  <span className="source-meta"> ({detail.run.fallback})</span>
                )}
              </dd>
              <dt>Started</dt>
              <dd>
                {when(detail.run.created_at)} · {runDuration(detail.run)}
              </dd>
              {detail.run.error && (
                <>
                  <dt>Error</dt>
                  <dd>{detail.run.error}</dd>
                </>
              )}
            </dl>
            <section aria-labelledby="findings-heading">
              <h2 id="findings-heading">Findings</h2>
              {detail.findings.length ? (
                <ul className="agent-findings">
                  {detail.findings.map((f) => (
                    <li key={`${f.path}:${f.line}`}>
                      <span
                        className={`chip run-${f.severity === 'high' ? 'bad' : f.severity === 'medium' ? 'warn' : 'neutral'}`}
                      >
                        {f.severity}
                      </span>{' '}
                      <code>
                        {f.path}:{f.line}
                      </code>{' '}
                      <strong>{f.title}</strong>
                      <p>{f.why}</p>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="source-empty">
                  No findings were posted
                  {detail.run.withheld ? ` (${detail.run.withheld} withheld)` : ''}.
                </p>
              )}
            </section>
            <section aria-labelledby="cost-heading">
              <h2 id="cost-heading">Cost</h2>
              {detail.cost.length ? (
                <div className="source-table-wrap">
                  <table className="source-table">
                    <tbody>
                      {detail.cost.map((c) => (
                        <tr key={`${c.at}:${c.amount}:${c.note ?? ''}:${c.input_tokens ?? ''}`}>
                          <td>{costLabel(c)}</td>
                          <td>{formatCost(costUsd(c))}</td>
                        </tr>
                      ))}
                      <tr>
                        <th scope="row">Total</th>
                        <td>{formatCost(detail.run.cost_usd)}</td>
                      </tr>
                    </tbody>
                  </table>
                </div>
              ) : (
                <p className="source-empty">Nothing was charged for this run.</p>
              )}
            </section>
            <section aria-labelledby="transcript-heading">
              <h2 id="transcript-heading">Transcript</h2>
              {detail.transcript ? (
                // biome-ignore lint/a11y/noNoninteractiveTabindex: a scrollable region must be reachable by keyboard.
                <pre className="agent-transcript" tabIndex={0}>
                  {detail.transcript}
                </pre>
              ) : (
                <p className="source-empty">No transcript was kept for this run.</p>
              )}
            </section>
          </>
        ))}
      <a {...linkTo({ view: 'agent-runs', ...space }, navigate)}>All runs</a>
    </div>
  );
}
