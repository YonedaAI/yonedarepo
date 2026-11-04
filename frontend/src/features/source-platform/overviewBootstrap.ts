// One freshly authorized Overview response, passed between routes only for its navigation.
import type { Detail } from './CodeParts';
import { OVERVIEW_COMMITS, type OverviewCommit } from './overviewModel';
import { chosenBranch } from './repoBranch';
import type { NamedRoute } from './repoNames';
import type { RepoStatus } from './repoStatus';
import type { SourceRoute } from './sourceRoute';

export type OverviewError = { code: string; message: string };
export type OverviewData = {
  ref: string;
  tree: {
    commit: string;
    path: string;
    entries: { name: string; type: string; id: string }[];
  } | null;
  latest: Detail | null;
  readme: {
    path: string;
    commit: string;
    encoding: string;
    content: string;
    size: number;
    executable: boolean;
  } | null;
  activity: { commits: OverviewCommit[] } | null;
  activity_request?: { ref: string; from: string; at: number };
  empty: boolean;
  errors?: Partial<Record<'tree' | 'latest' | 'readme' | 'activity', OverviewError>>;
};
export type OverviewStatus = RepoStatus & { insights?: boolean; overview?: OverviewData };
export type NavigationOverview = { repo: string; status: OverviewStatus };
export type OverviewHandoff = {
  route: SourceRoute;
  viewer: string;
  tick: number;
  overview: NavigationOverview;
};
export type OverviewViewer = { admitted?: string; generation: number };

/** Initial discovery identifies this page's existing viewer; later transitions replace it. */
export function advanceOverviewViewer(state: OverviewViewer, viewer: string, settled: boolean) {
  if (!settled || state.admitted === viewer) return state;
  return {
    admitted: viewer,
    generation: state.generation + (state.admitted === undefined ? 0 : 1),
  };
}

export const overviewStatusPath = (repo: string, ref: string) =>
  `/repos/${repo}?summary=true&overview=true&ref=${encodeURIComponent(ref)}`;

/** Only addresses already parsed as Overview opt into the extra response. */
export function namedOverviewRef(route: Extract<NamedRoute, { view: 'repo-name' }>) {
  const query = new URLSearchParams(route.search);
  if (query.has('at')) return undefined;
  if (!route.rest && !query.has('ref')) return 'main';
  return route.rest === 'overview' ? query.get('ref') || 'main' : undefined;
}

/** An explicit response is valid only for the exact navigation and viewer that got it. */
export function overviewForNavigation(
  handoff: OverviewHandoff | undefined,
  route: SourceRoute,
  viewer: string,
  tick: number,
  principal?: string,
) {
  if (
    !handoff ||
    handoff.route !== route ||
    handoff.viewer !== viewer ||
    handoff.tick !== tick ||
    (principal !== undefined &&
      handoff.overview.status.viewer.public !== true &&
      handoff.overview.status.viewer.principal !== principal) ||
    route.view !== 'overview' ||
    handoff.overview.repo !== route.repo ||
    handoff.overview.status.overview?.ref !== (route.ref ?? chosenBranch(route.repo))
  )
    return undefined;
  return handoff.overview.status;
}

/** Optional history follows the exact captured tree, with fresh server admission. */
export function overviewActivityPath(
  repo: string,
  ref: string,
  request?: OverviewData['activity_request'],
) {
  const query = new URLSearchParams({ ref, limit: String(OVERVIEW_COMMITS) });
  if (request) {
    query.set('ref', request.ref);
    query.set('from', request.from);
    query.set('at', String(request.at));
    query.set('view', 'overview');
  }
  return `/repos/${repo}/log?${query}`;
}
