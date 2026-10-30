// The top bar's breadcrumbs (`ada / Agents / Code review`): the account (home, or an org's
// page), the Agents page, then the page itself. Every crumb but the last links (`to`); pages
// without a parent get none and the top bar shows their title.
import { agentName } from '../agents/agentsModel';
import { isAgentsRoute, type SourceRoute } from '../source-platform/sourceRoute';

export interface Crumb {
  label: string;
  to?: SourceRoute;
}

export function breadcrumbs(route: SourceRoute, account: string | undefined): Crumb[] | null {
  if (!isAgentsRoute(route)) return null;
  const space = route.workspace ? { workspace: route.workspace } : {};
  const owner = route.workspace ?? account;
  const trail: Crumb[] = owner
    ? [
        {
          label: owner,
          to: route.workspace ? { view: 'org', org: route.workspace } : { view: 'home' },
        },
      ]
    : [];
  if (route.view === 'agents-home') return [...trail, { label: 'Agents' }];
  trail.push({ label: 'Agents', to: { view: 'agents-home', ...space } });
  const agent = (id: string): Crumb => ({
    label: agentName(id),
    to: { view: 'agent-settings', agent: id, ...space },
  });
  switch (route.view) {
    case 'agent-settings':
      return [...trail, { label: route.agent === 'new' ? 'New agent' : agentName(route.agent) }];
    case 'agent-configure':
      return [...trail, agent(route.agent), { label: 'Configure' }];
    case 'agent-runs':
      return [...trail, ...(route.agent ? [agent(route.agent)] : []), { label: 'Runs' }];
    case 'agent-run':
      return [...trail, { label: 'Runs', to: { view: 'agent-runs', ...space } }, { label: 'Run' }];
  }
}
