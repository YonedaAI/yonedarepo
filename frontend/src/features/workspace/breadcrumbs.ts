// The top bar's breadcrumbs (`ada / Agents / Code review`, `Account / Billing`, `ada / app /
// Landings`): the account (home, or an org's page), the Agents page or the repository, then the
// page itself. Every crumb but the last links (`to`); pages without a parent get none and the
// top bar shows their title.
import { ACCOUNT_SECTION_TITLES } from '../account-settings/settingsRoute';
import { agentName } from '../agents/agentsModel';
import { REPO_PAGES } from '../shell/AppSidebar';
import {
  isAgentsRoute,
  routeRepo,
  routeTab,
  type SourceRoute,
  tabRoute,
} from '../source-platform/sourceRoute';

export interface Crumb {
  label: string;
  to?: SourceRoute;
  /** The repository switcher stands in for this crumb's link. */
  switcher?: boolean;
}

/** The open repository as the shell knows it, and the signed-in account's handle. */
export type TrailRepo = { owner?: string; name?: string };

/** Where an owner's name leads: the viewer's Repositories page, or that owner's list. */
export const ownerRepos = (handle: string, self: string | undefined): SourceRoute =>
  handle === self ? { view: 'repositories' } : { view: 'profile', handle, tab: 'repositories' };

function repoTrail(route: SourceRoute, open: TrailRepo, self?: string): Crumb[] | null {
  const repo = routeRepo(route);
  const tab = routeTab(route);
  const page = REPO_PAGES.find((p) => p.id === tab)?.label;
  if (!repo || !tab || !page || !open.name) return null;
  return [
    ...(open.owner ? [{ label: open.owner, to: ownerRepos(open.owner, self) }] : []),
    { label: open.name, to: tabRoute('overview', repo), switcher: true },
    { label: page },
  ];
}

export function breadcrumbs(
  route: SourceRoute,
  account: string | undefined,
  open: TrailRepo = {},
  self?: string,
): Crumb[] | null {
  if (route.view === 'repositories' && self)
    return [{ label: self, to: { view: 'profile', handle: self } }, { label: 'Repositories' }];
  if (route.view === 'settings')
    return [
      { label: 'Account', to: { view: 'settings', section: 'general' } },
      { label: ACCOUNT_SECTION_TITLES[route.section] },
    ];
  if (!isAgentsRoute(route)) return repoTrail(route, open, self);
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
