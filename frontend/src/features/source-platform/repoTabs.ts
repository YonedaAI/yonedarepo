// The repository's sidebar pages and which routes each one holds.
import type { SourceRoute } from './sourceRoute';

/** The repository's sidebar pages, each highlighted on every route it holds: Commits holds
 * `history`, `transactions`, `branches` and `commit`, and Landings holds `change`. */
export type RepoTab =
  | 'overview'
  | 'files'
  | 'changes'
  | 'tower'
  | 'agents'
  | 'commits'
  | 'sessions'
  | 'context'
  | 'insights'
  | 'memories'
  | 'releases'
  | 'search'
  | 'settings';

/** The sidebar page a repository route belongs to. */
export function routeTab(route: SourceRoute): RepoTab | undefined {
  switch (route.view) {
    case 'overview':
      return 'overview';
    case 'files':
      return 'files';
    case 'history':
    case 'transactions':
    case 'branches':
    case 'commit':
      return 'commits';
    case 'changes':
    case 'change':
      return 'changes';
    case 'tower':
      return 'tower';
    case 'releases':
    case 'release':
      return 'releases';
    case 'agents':
      return route.section === 'sessions'
        ? 'sessions'
        : route.section === 'memories'
          ? 'memories'
          : 'agents';
    case 'session':
      return 'sessions';
    case 'context':
    case 'insights':
      return route.view;
    case 'search':
      return 'search';
    case 'repo-settings':
      return 'settings';
    default:
      return undefined;
  }
}

/** Where a page starts. */
export function tabRoute(tab: RepoTab, repo: string): SourceRoute {
  if (tab === 'overview') return { view: 'overview', repo };
  if (tab === 'files') return { view: 'files', repo, path: '', ref: 'main' };
  if (tab === 'commits') return { view: 'history', repo, ref: 'main' };
  if (tab === 'changes') return { view: 'changes', repo };
  if (tab === 'tower') return { view: 'tower', repo };
  if (tab === 'releases') return { view: 'releases', repo };
  if (tab === 'sessions') return { view: 'agents', repo, section: 'sessions' };
  if (tab === 'agents') return { view: 'agents', repo, section: 'contracts' };
  if (tab === 'context' || tab === 'insights') return { view: tab, repo };
  if (tab === 'memories') return { view: 'agents', repo, section: 'memories' };
  if (tab === 'search') return { view: 'search', repo, query: '' };
  return { view: 'repo-settings', repo, section: 'rules' };
}
