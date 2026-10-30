// Agents (`/agents`): the workspace's managed agents. A top row (All agents, workspace menu,
// filter, search, View runs, New agent), then "Managed by YonedaRepo": the credit card and one
// card per agent YonedaRepo maintains. An agent not set up offers Add agent (its set-up page);
// a set-up one shows Active or Paused, its newest result and run count, and a ⋮ menu.
import { Filter, MoreHorizontal, Search } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { AgentState, ManagedCredit, WorkspaceState } from '../../../../shared/managed-agents';
import { linkTo, type Navigate } from '../shell/useRoute';
import { managedApi } from '../source-platform/sourceApi';
import { useSource } from '../source-platform/useSource';
import { AgentMenu } from './AgentMenu';
import { useAgentActions } from './agentActions';
import { AgentIcon, loadState, ResultTile } from './agentParts';
import {
  CREATE_OWN_GATE,
  cardState,
  creditPercent,
  formatCost,
  type MenuAction,
  menuItems,
  STATUS_BADGES,
  syncAgents,
  usedText,
  visibleAgents,
  workspaceOptions,
  workspacePath,
} from './agentsModel';

type Space = { workspace?: string };

/** The starting credit: what is used, and billing (coming) for more and for agents of your own. */
function CreditCard({ credit }: { credit: ManagedCredit }) {
  return (
    <section className="agent-card agent-promo" aria-labelledby="promo-heading">
      <h3 id="promo-heading">This one is on us!</h3>
      <p>
        YonedaRepo adds {formatCost(credit.granted_usd)} of starting credit when you set up your
        first agent, for the agents it maintains. Set up billing to create agents of your own.
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
  onAct,
  navigate,
}: {
  agent: AgentState;
  space: Space;
  busy: boolean;
  onAct: (agent: AgentState, action: MenuAction) => void;
  navigate: Navigate;
}) {
  const card = cardState(agent);
  return (
    <section className="agent-card" aria-labelledby={`card-${agent.id}`}>
      <div className="agent-card-head">
        <h3 id={`card-${agent.id}`}>
          {card.configured ? (
            <a {...linkTo({ view: 'agent-settings', agent: agent.id, ...space }, navigate)}>
              {agent.settings.name}
            </a>
          ) : (
            agent.settings.name
          )}
        </h3>
        <AgentIcon icon={agent.icon} />
      </div>
      <p>{agent.pitch}</p>
      {card.configured && (
        <p className="agent-card-status">
          <span className={`chip ${card.status === 'active' ? 'run-good' : 'run-neutral'}`}>
            {STATUS_BADGES[card.status]}
          </span>
          {card.last && <ResultTile tile={card.last} />}
          <span className="source-meta">
            {card.runs} run{card.runs === 1 ? '' : 's'} · {card.repos}
          </span>
        </p>
      )}
      <div className="agent-card-actions">
        {card.configured ? (
          <>
            <a
              className="button-link quiet"
              {...linkTo({ view: 'agent-settings', agent: agent.id, ...space }, navigate)}
            >
              Open
            </a>
            <AgentMenu
              label={`${agent.settings.name} actions`}
              items={menuItems(agent)}
              busy={busy}
              onPick={(action) => onAct(agent, action)}
            />
          </>
        ) : (
          <a
            className="button-link agent-enable"
            {...linkTo({ view: 'agent-configure', agent: agent.id, ...space }, navigate)}
          >
            Add agent
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
  const space: Space = workspace === account ? {} : { workspace };
  const spaces = workspaceOptions(account, orgs);
  const actions = useAgentActions(workspace, space, navigate, loaded.reload);
  const state = loaded.data;
  const agents = state ? visibleAgents(state.agents, query, enabledOnly) : [];
  const { reload } = loaded;
  // Connect repositories made outside the web app (the CLI, an import) to agents set to run on
  // all repositories; reload only when that changed something.
  useEffect(() => {
    let live = true;
    syncAgents(workspace, managedApi).then((connected) => {
      if (live && connected > 0) reload();
    });
    return () => {
      live = false;
    };
  }, [workspace, reload]);
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
            aria-label="Show only agents you set up"
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
          <button
            type="button"
            className="agents-new"
            disabled
            aria-describedby="new-agent-hint"
            title={CREATE_OWN_GATE}
          >
            New agent
          </button>
          <span id="new-agent-hint" className="sr-only">
            {CREATE_OWN_GATE}
          </span>
        </div>
      </div>
      <h1 className="agents-heading">Managed by YonedaRepo</h1>
      {loadState(loaded, 'agents') ??
        (state && (
          <div className="agents-grid">
            <CreditCard credit={state.credit} />
            {agents.map((agent) => (
              <AgentCard
                key={agent.id}
                agent={agent}
                space={space}
                busy={actions.busy === agent.id}
                onAct={actions.act}
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
      {actions.notices}
      {actions.dialog}
    </div>
  );
}
