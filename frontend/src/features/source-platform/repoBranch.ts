// The branch a person is looking at in each repository: it stays across Overview, Files and
// Commits until they switch back. Held for this page load, so a fresh visit starts on main.
import type { SourceRoute } from './sourceRoute';

const chosen = new Map<string, string>();

export const chosenBranch = (repo: string) => chosen.get(repo) ?? 'main';

/** Notes the branch a route names, if it names one. */
export function noteBranch(route: SourceRoute) {
  if ('repo' in route && 'ref' in route && route.ref) chosen.set(route.repo, route.ref);
}
