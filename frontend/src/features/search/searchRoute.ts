// The Search page's address: `/search?q=<query>&repo=<id>`, so a search can be linked and Back
// returns to it. `within` and not `repo`, so the repository shell stays out of the page.
import { REPO_ID } from '../source-platform/repoNames';

export type SearchRoute = { view: 'global-search'; q?: string; within?: string };

/** The route for `q` (empty: none) in one repository, or in all of them. */
export const searchRoute = (q?: string, within?: string): SearchRoute => ({
  view: 'global-search',
  ...(q ? { q } : {}),
  ...(within ? { within } : {}),
});

export function parseSearchParams(params: URLSearchParams): SearchRoute {
  const within = params.get('repo') ?? '';
  return searchRoute(params.get('q') ?? '', REPO_ID.test(within) ? within : undefined);
}

export function formatSearchRoute(route: SearchRoute): string {
  const query = new URLSearchParams();
  if (route.q) query.set('q', route.q);
  if (route.within) query.set('repo', route.within);
  return query.size ? `/search?${query}` : '/search';
}
