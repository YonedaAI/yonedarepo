// The workspace Agents pages, by route: the overview, one agent's page or its set-up form (or a
// new agent),
// the runs list and one run. The workspace is the route's (an org) or the signed-in account.
import type { Navigate } from '../shell/useRoute';
import type { AgentsRoute } from '../source-platform/sourceRoute';
import { AgentRunDetail, AgentRuns } from './AgentRuns';
import { AgentSettingsPage } from './AgentSettingsPage';
import { AgentsPage } from './AgentsPage';

export function AgentsRoot({
  route,
  account,
  orgs,
  navigate,
  onNewRepository,
}: {
  route: AgentsRoute;
  account?: string;
  orgs: { org: string; role: string }[];
  navigate: Navigate;
  /** Opens the app's New repository dialog (the set-up page offers it with no repositories). */
  onNewRepository?: () => void;
}) {
  return <div className="agents-root">{page(route, account, orgs, navigate, onNewRepository)}</div>;
}

function page(
  route: AgentsRoute,
  account: string | undefined,
  orgs: { org: string; role: string }[],
  navigate: Navigate,
  onNewRepository?: () => void,
) {
  const workspace = route.workspace ?? account;
  if (!workspace)
    return (
      <div className="source-empty-state">
        <p>
          <strong>Sign in to see your agents.</strong>
        </p>
      </div>
    );
  const space =
    route.workspace && route.workspace !== account ? { workspace: route.workspace } : {};
  if (route.view === 'agent-settings' || route.view === 'agent-configure')
    return (
      <AgentSettingsPage
        key={`${route.view}:${route.agent}`}
        workspace={workspace}
        agent={route.agent}
        account={account}
        configure={route.view === 'agent-configure'}
        navigate={navigate}
        onNewRepository={onNewRepository}
      />
    );
  if (route.view === 'agent-runs')
    return (
      <AgentRuns workspace={workspace} agent={route.agent} space={space} navigate={navigate} />
    );
  if (route.view === 'agent-run')
    return (
      <AgentRunDetail
        workspace={workspace}
        repo={route.runRepo}
        run={route.run}
        space={space}
        navigate={navigate}
      />
    );
  return (
    <AgentsPage
      key={workspace}
      workspace={workspace}
      account={account}
      orgs={orgs}
      navigate={navigate}
    />
  );
}
