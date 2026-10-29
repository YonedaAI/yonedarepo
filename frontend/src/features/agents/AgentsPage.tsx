// Agents (`/agents`): the workspace's managed agents. A top row (All agents, workspace menu,
// filter, search, View runs, New agent), then "Managed by YonedaRepo": the promotional credit
// card and one card per agent YonedaRepo maintains. Enable opens the agent's settings page
// pre-filled; an enabled card shows its newest result and run count, with Edit and Disable.
import { Filter, MoreHorizontal, Search } from 'lucide-react';
import { useState } from 'react';
import type {
  AgentState,
  AgentUpdate,
  ManagedCredit,
  WorkspaceState,
} from '../../../../shared/managed-agents';
import { linkTo, type Navigate } from '../shell/useRoute';
import { Failure } from '../source-platform/SourceStatus';
import { managedApi } from '../source-platform/sourceApi';
import { useSource } from '../source-platform/useSource';
import { AgentIcon, loadState, ResultTile } from './agentParts';
import {
  agentPath,
  cardState,
  creditPercent,
  formatCost,
  usedText,
  visibleAgents,
  workspaceOptions,
  workspacePath,
} from './agentsModel';

type Space = { workspace?: string };

function PromoCard({ credit }: { credit: ManagedCredit }) {
  return (
    <section className="agent-card agent-promo" aria-labelledby="promo-heading">
      <h3 id="promo-heading">This one is on us!</h3>
      <p>
        YonedaRepo adds {formatCost(credit.granted_usd)} of promotional credit for your first runs
        of the agents it maintains. Set up billing to create agents of your own.
      </p>
      <div className="agent-usage">
        <div className="managed-meter" aria-hidden="true">
          <span
            style={{ width: `${creditPercent(credit)}%` }}
            className={credit.paused ? 'spent' : undefined}
          />
        </div>
        <span>{usedText(credit)}</span>
      </div>
      {credit.paused && (
        <p className="managed-paused" role="status">
          The credit is used up, so runs are paused until credit is added.
        </p>
      )}
      <div className="agent-card-actions">
        <button type="button" className="quiet" disabled title="Billing is coming">
          Set up billing
        </button>
        <span className="source-meta">Coming soon</span>
      </div>
    </section>
  );
}

function AgentCard({
  agent,
  space,
  busy,
  onDisable,
  navigate,
}: {
  agent: AgentState;
  space: Space;
  busy: boolean;
  onDisable: (agent: AgentState) => void;
  navigate: Navigate;
}) {
  const card = cardState(agent);
  const settings = linkTo({ view: 'agent-settings', agent: agent.id, ...space }, navigate);
  return (
    <section className="agent-card" aria-labelledby={`card-${agent.id}`}>
      <div className="agent-card-head">
        <h3 id={`card-${agent.id}`}>{agent.settings.name}</h3>
        <AgentIcon icon={agent.icon} />
      </div>
      <p>{agent.pitch}</p>
      {card.enabled && (
        <p className="agent-card-status">
          <span className="chip run-good">Enabled</span>
          {card.last && <ResultTile tile={card.last} />}
          <span className="source-meta">
            {card.runs} run{card.runs === 1 ? '' : 's'} · {card.repos} repositor
            {card.repos === 1 ? 'y' : 'ies'}
          </span>
        </p>
      )}
      <div className="agent-card-actions">
        {card.enabled ? (
          <>
            <a className="button-link quiet" {...settings}>
              Edit
            </a>
            <button
              type="button"
              className="quiet"
              disabled={busy}
              onClick={() => onDisable(agent)}
            >
              {busy ? 'Disabling…' : 'Disable'}
            </button>
          </>
        ) : (
          <a className="button-link agent-enable" {...settings}>
            Enable
          </a>
        )}
      </div>
    </section>
  );
}

export function AgentsPage({
  workspace,
  account,
  orgs,
  navigate,
}: {
  workspace: string;
  account?: string;
  orgs: { org: string; role: string }[];
  navigate: Navigate;
}) {
  const loaded = useSource<WorkspaceState>(workspacePath(workspace), '/api/managed');
  const [query, setQuery] = useState('');
  const [searching, setSearching] = useState(false);
  const [enabledOnly, setEnabledOnly] = useState(false);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const space: Space = workspace === account ? {} : { workspace };
  const spaces = workspaceOptions(account, orgs);

  async function disable(agent: AgentState) {
    setBusy(agent.id);
    setError('');
    try {
      const body: AgentUpdate = { repos: [] };
      await managedApi(agentPath(workspace, agent.id), { method: 'PUT', body });
      loaded.reload();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy('');
    }
  }

  const state = loaded.data;
  const agents = state ? visibleAgents(state.agents, query, enabledOnly) : [];
  return (
    <div className="agents-page">
      <div className="agents-toolbar">
        <div className="agents-toolbar-left">
          <span className="agents-pill">All agents</span>
          {spaces.length > 1 && (
            <details className="agents-menu">
              <summary aria-label="Workspace">
                <MoreHorizontal size={16} aria-hidden="true" />
              </summary>
              <nav className="agents-menu-list" aria-label="Workspaces">
                {spaces.map((s) => (
                  <a
                    key={s.value}
                    aria-current={s.value === workspace ? 'page' : undefined}
                    {...linkTo(
                      {
                        view: 'agents-home',
                        ...(s.value === account ? {} : { workspace: s.value }),
                      },
                      navigate,
                    )}
                  >
                    {s.label}
                  </a>
                ))}
              </nav>
            </details>
          )}
          {workspace !== account && <span className="source-meta">{workspace}</span>}
        </div>
        <div className="agents-toolbar-right">
          <button
            type="button"
            className="icon-button"
            aria-label="Show only enabled agents"
            aria-pressed={enabledOnly}
            onClick={() => setEnabledOnly(!enabledOnly)}
          >
            <Filter size={16} aria-hidden="true" />
          </button>
          {searching ? (
            <input
              type="search"
              aria-label="Search agents"
              placeholder="Search agents"
              value={query}
              // biome-ignore lint/a11y/noAutofocus: the field opens because the person asked to search.
              autoFocus
              onChange={(e) => setQuery(e.target.value)}
              onBlur={() => !query && setSearching(false)}
            />
          ) : (
            <button
              type="button"
              className="icon-button"
              aria-label="Search agents"
              onClick={() => setSearching(true)}
            >
              <Search size={16} aria-hidden="true" />
            </button>
          )}
          <a className="button-link quiet" {...linkTo({ view: 'agent-runs', ...space }, navigate)}>
            View runs
          </a>
          <a
            className="button-link agents-new"
            aria-describedby="new-agent-hint"
            {...linkTo({ view: 'agent-settings', agent: 'new', ...space }, navigate)}
          >
            New agent
          </a>
          <span id="new-agent-hint" className="sr-only">
            Needs billing, which is coming
          </span>
        </div>
      </div>
      <h1 className="agents-heading">Managed by YonedaRepo</h1>
      {loadState(loaded, 'agents') ??
        (state && (
          <div className="agents-grid">
            <PromoCard credit={state.credit} />
            {agents.map((agent) => (
              <AgentCard
                key={agent.id}
                agent={agent}
                space={space}
                busy={busy === agent.id}
                onDisable={disable}
                navigate={navigate}
              />
            ))}
            {!agents.length && (
              <p className="source-empty">
                No agent matches{query ? ` “${query}”` : ' the filter'}.
              </p>
            )}
          </div>
        ))}
      {error && <Failure error={error} />}
    </div>
  );
}
