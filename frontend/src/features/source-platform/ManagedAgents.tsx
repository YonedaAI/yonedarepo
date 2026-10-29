// Agent tools → Managed: the reviewers YonedaRepo runs for this repository (code review,
// security review) from its own managed Worker, which reads changes and posts comments and a
// check through the public API like any client. Each card turns one on or off (owner and
// admins); the credit meter is the account's agent usage. Runs lists every run with its model
// and cost.
import { useState } from 'react';
import type {
  ManagedAgentState,
  ManagedCredit,
  ManagedRepoState,
  ManagedRun,
} from '../../../../shared/managed-agents';
import { linkTo, type Navigate } from '../shell/useRoute';
import {
  agentPath,
  canToggle,
  creditPercent,
  creditText,
  findingsText,
  formatCost,
  managedPath,
  managedUnavailable,
  requireCheckNote,
  runStatusLabel,
  runsPath,
  runTone,
  toggleBody,
} from './managedModel';
import { Failure, Loading } from './SourceStatus';
import { managedApi, shortSha, when } from './sourceApi';
import { type Loaded, useSource } from './useSource';

function Unavailable() {
  return (
    <div className="source-empty-state">
      <p>
        <strong>Managed agents are not available here.</strong> This deployment does not run
        YonedaRepo&apos;s managed agents.
      </p>
    </div>
  );
}

/** Loading, unavailable or failed; null once there is data to show. */
function loadState<T>(loaded: Loaded<T>, what: string) {
  if (loaded.loading && !loaded.data) return <Loading what={what} />;
  if (loaded.error && managedUnavailable(loaded)) return <Unavailable />;
  if (loaded.error) return <Failure error={loaded.error} onRetry={loaded.reload} what={what} />;
  return null;
}

export function RunStatusChip({ run }: { run: Pick<ManagedRun, 'status'> }) {
  return (
    <span className={`chip run-status run-${runTone(run.status)}`}>
      {runStatusLabel(run.status)}
    </span>
  );
}

function CreditMeter({ credit }: { credit: ManagedCredit }) {
  const percent = creditPercent(credit);
  return (
    <section className="managed-card managed-credit" aria-labelledby="credit-heading">
      <h3 id="credit-heading">Agent credit</h3>
      <p className="managed-figure">{creditText(credit)}</p>
      {/* The figure above says the amount; the bar only draws it. */}
      <div className="managed-meter" aria-hidden="true">
        <span style={{ width: `${percent}%` }} className={credit.paused ? 'spent' : undefined} />
      </div>
      <p className="source-meta">
        {formatCost(credit.balance_usd)} left. Platform features are free; only agent model calls
        use credit.
      </p>
      {credit.paused && (
        <p className="managed-paused" role="status">
          The credit is used up, so agent runs are paused. They start again once credit is added.
        </p>
      )}
      <button type="button" disabled title="Billing is not available yet">
        Set up billing (coming)
      </button>
    </section>
  );
}

function AgentCard({
  repo,
  agent,
  admin,
  busy,
  onToggle,
  navigate,
}: {
  repo: string;
  agent: ManagedAgentState;
  admin: boolean;
  busy: boolean;
  onToggle: (agent: ManagedAgentState) => void;
  navigate: Navigate;
}) {
  const run = agent.last_run;
  return (
    <section className="managed-card" aria-labelledby={`agent-${agent.id}`}>
      <div className="managed-card-head">
        <h3 id={`agent-${agent.id}`}>{agent.label}</h3>
        <span className={`chip ${agent.enabled ? 'run-good' : ''}`}>
          {agent.enabled ? 'On' : 'Off'}
        </span>
      </div>
      <p>{agent.description}</p>
      <dl className="managed-facts">
        <dt>Model</dt>
        <dd>
          <code>{agent.model}</code>
        </dd>
        <dt>Check</dt>
        <dd>
          <code>{agent.check}</code>
        </dd>
        <dt>Last run</dt>
        <dd>
          {run ? (
            <>
              <RunStatusChip run={run} /> on change #{run.change} · {when(run.created_at)}
            </>
          ) : (
            'Not run yet'
          )}
        </dd>
        <dt>Findings</dt>
        <dd>{run ? findingsText(run) : '—'}</dd>
      </dl>
      <div className="managed-actions">
        {canToggle(admin) && (
          <button
            type="button"
            className={agent.enabled ? 'quiet' : undefined}
            disabled={busy}
            onClick={() => onToggle(agent)}
          >
            {busy ? 'Saving…' : agent.enabled ? 'Disable' : 'Enable'}
          </button>
        )}
        <a {...linkTo({ view: 'agents', repo, section: 'runs', agent: agent.id }, navigate)}>
          View runs
        </a>
      </div>
    </section>
  );
}

export function ManagedAgents({
  repo,
  admin,
  navigate,
}: {
  repo: string;
  admin: boolean;
  navigate: Navigate;
}) {
  const loaded = useSource<ManagedRepoState>(managedPath(repo), '/api/managed');
  const [state, setState] = useState<ManagedRepoState>();
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const shown = state ?? loaded.data;
  const pending = loadState(loaded, 'managed agents');
  if (pending && !state) return pending;
  if (!shown) return null;

  async function toggle(agent: ManagedAgentState) {
    setBusy(agent.id);
    setError('');
    try {
      setState(
        await managedApi<ManagedRepoState>(agentPath(repo, agent.id), {
          body: toggleBody(!agent.enabled),
        }),
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy('');
    }
  }

  return (
    <section aria-labelledby="managed-heading" className="managed-agents">
      <div className="agent-head">
        <h2 id="managed-heading">Managed by YonedaRepo</h2>
      </div>
      <p className="agent-subtitle">
        Agents YonedaRepo runs on each change: when it opens and on every push, they comment on the
        lines with problems and record a check on the head commit.
      </p>
      {!admin && (
        <p className="source-meta">Only the owner and admins can turn these agents on or off.</p>
      )}
      <div className="managed-grid">
        {shown.agents.map((agent) => (
          <AgentCard
            key={agent.id}
            repo={repo}
            agent={agent}
            admin={admin}
            busy={busy === agent.id}
            onToggle={toggle}
            navigate={navigate}
          />
        ))}
        <CreditMeter credit={shown.credit} />
      </div>
      {error && <Failure error={error} />}
      <p className="source-meta">
        {requireCheckNote(
          shown.agents.map((a) => a.check),
          shown.token_name,
        )}
      </p>
    </section>
  );
}

export function ManagedRuns({
  repo,
  agent,
  navigate,
}: {
  repo: string;
  agent?: string;
  navigate: Navigate;
}) {
  const state = useSource<ManagedRepoState>(managedPath(repo), '/api/managed');
  const loaded = useSource<{ runs: ManagedRun[] }>(runsPath(repo, agent), '/api/managed');
  const pending = loadState(loaded, 'agent runs');
  const agents = state.data?.agents ?? [];
  const label = agents.find((a) => a.id === agent)?.label;
  const runs = loaded.data?.runs ?? [];
  return (
    <section aria-labelledby="runs-heading">
      <div className="agent-head">
        <h2 id="runs-heading">{label ? `${label} runs` : 'Managed agent runs'}</h2>
        <nav className="segmented" aria-label="Filter runs by agent">
          <a
            aria-current={agent ? undefined : 'page'}
            {...linkTo({ view: 'agents', repo, section: 'runs' }, navigate)}
          >
            All
          </a>
          {agents.map((a) => (
            <a
              key={a.id}
              aria-current={a.id === agent ? 'page' : undefined}
              {...linkTo({ view: 'agents', repo, section: 'runs', agent: a.id }, navigate)}
            >
              {a.label}
            </a>
          ))}
        </nav>
      </div>
      <p className="agent-subtitle">
        <a {...linkTo({ view: 'agents', repo, section: 'managed' }, navigate)}>
          Back to managed agents
        </a>
      </p>
      {pending ??
        (runs.length === 0 ? (
          <div className="source-empty-state">
            <p>
              <strong>No runs yet.</strong> A run starts when a change opens or its branch gets a
              push while the agent is on.
            </p>
          </div>
        ) : (
          <div className="source-table-wrap">
            <table className="source-table managed-runs">
              <thead>
                <tr>
                  <th scope="col">Change</th>
                  <th scope="col">Head</th>
                  {!agent && <th scope="col">Agent</th>}
                  <th scope="col">Status</th>
                  <th scope="col">Model</th>
                  <th scope="col">Cost</th>
                  <th scope="col">Findings</th>
                  <th scope="col">When</th>
                </tr>
              </thead>
              <tbody>
                {runs.map((run) => (
                  <tr key={run.id}>
                    <td>
                      <a {...linkTo({ view: 'change', repo, number: run.change }, navigate)}>
                        #{run.change}
                      </a>
                    </td>
                    <td>
                      <code>{shortSha(run.head)}</code>
                    </td>
                    {!agent && (
                      <td>{agents.find((a) => a.id === run.agent)?.label ?? run.agent}</td>
                    )}
                    <td>
                      <RunStatusChip run={run} />
                      {run.error && <small className="source-meta"> {run.error}</small>}
                    </td>
                    <td>
                      <code>{run.model}</code>
                    </td>
                    <td>{formatCost(run.cost_usd)}</td>
                    <td>{findingsText(run)}</td>
                    <td>{when(run.created_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ))}
    </section>
  );
}
