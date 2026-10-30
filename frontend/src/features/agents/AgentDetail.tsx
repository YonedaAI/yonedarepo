// A set-up agent's page (`/agents/<id>`): its runs (run, status, created in UTC) beside what it
// is (harness and model), when it runs, its repositories and its history, with its Active or
// Paused badge and the ⋮ menu (Pause or Resume, Run now, Configure, Create your own, Archive).
import type { AgentState, ManagedRun, WorkspaceState } from '../../../../shared/managed-agents';
import { HARNESS_LABELS, modelRate } from '../../../../shared/managed-agents';
import { linkTo, type Navigate } from '../shell/useRoute';
import { useSource } from '../source-platform/useSource';
import { AgentMenu } from './AgentMenu';
import { useAgentActions } from './agentActions';
import { AgentIcon, HistoryStrip, loadState, StatusChip } from './agentParts';
import {
  ALL_REPOS_LABEL,
  agentStatus,
  createdText,
  formatUtc,
  menuItems,
  runsPath,
  STATUS_BADGES,
  triggerText,
} from './agentsModel';

type Space = { workspace?: string };

function Runs({
  runs,
  repos,
  space,
  navigate,
}: {
  runs: ManagedRun[];
  repos: Map<string, string>;
  space: Space;
  navigate: Navigate;
}) {
  if (!runs.length)
    return (
      <p className="source-empty">
        No runs yet. It reviews a change when one opens or is pushed on its repositories.
      </p>
    );
  return (
    <div className="source-table-wrap">
      <table className="source-table agent-detail-runs">
        <thead>
          <tr>
            <th>Run</th>
            <th>Status</th>
            <th>Created (UTC)</th>
          </tr>
        </thead>
        <tbody>
          {runs.map((run) => (
            <tr key={run.id}>
              <td>
                <a
                  {...linkTo(
                    { view: 'agent-run', runRepo: run.repo, run: run.id, ...space },
                    navigate,
                  )}
                >
                  {repos.get(run.repo) ?? run.repo} #{run.change}
                </a>
              </td>
              <td>
                <StatusChip run={run} />
              </td>
              <td>{formatUtc(run.created_at)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function AgentDetail({
  workspace,
  state,
  agent,
  space,
  navigate,
  onChanged,
}: {
  workspace: string;
  state: WorkspaceState;
  agent: AgentState;
  space: Space;
  navigate: Navigate;
  onChanged: () => void;
}) {
  const runs = useSource<{ runs: ManagedRun[] }>(
    runsPath(workspace, { agent: agent.id }, 50),
    '/api/managed',
  );
  const actions = useAgentActions(workspace, space, navigate, () => {
    onChanged();
    runs.reload();
  });
  const status = agentStatus(agent);
  const names = new Map(state.repos.map((r) => [r.id, r.name]));
  const s = agent.settings;
  return (
    <div className="agent-detail">
      <div className="agent-settings-head agent-detail-head">
        <AgentIcon icon={agent.icon} />
        <div>
          <h1>
            {s.name}{' '}
            <span className={`chip ${status === 'active' ? 'run-good' : 'run-neutral'}`}>
              {STATUS_BADGES[status]}
            </span>
          </h1>
          <p>{s.description}</p>
        </div>
        <AgentMenu
          label={`${s.name} actions`}
          items={menuItems(agent)}
          busy={actions.busy === agent.id}
          align="end"
          onPick={(action) => actions.act(agent, action)}
        />
      </div>
      {actions.notices}
      <div className="agent-detail-grid">
        <section aria-labelledby="runs-heading">
          <h2 id="runs-heading">Runs</h2>
          {loadState(runs, 'runs') ??
            (runs.data && (
              <Runs runs={runs.data.runs} repos={names} space={space} navigate={navigate} />
            ))}
          <a {...linkTo({ view: 'agent-runs', agent: agent.id, ...space }, navigate)}>
            All runs with cost and model
          </a>
        </section>
        <aside className="agent-detail-side" aria-label="About this agent">
          <h2>Agent</h2>
          <p>
            {HARNESS_LABELS[s.harness]} · {modelRate(s.provider, s.model)?.label ?? s.model}
          </p>
          <h2>When to run</h2>
          <p>{triggerText(s.trigger)}</p>
          <h2>Repositories</h2>
          {agent.all_repos ? (
            <p>{ALL_REPOS_LABEL}</p>
          ) : agent.enabled_repos.length ? (
            <ul className="agent-detail-repos">
              {agent.enabled_repos.map((id) => (
                <li key={id}>{names.get(id) ?? id}</li>
              ))}
            </ul>
          ) : (
            <p className="source-meta">None selected.</p>
          )}
          <h2>Last results</h2>
          <HistoryStrip history={agent.history} />
          <h2>History</h2>
          <p className="source-meta">{createdText(agent)}</p>
          <a
            className="button-link quiet"
            {...linkTo({ view: 'agent-configure', agent: agent.id, ...space }, navigate)}
          >
            Configure
          </a>
        </aside>
      </div>
      {actions.dialog}
    </div>
  );
}
