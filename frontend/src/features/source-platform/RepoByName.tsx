// A readable repository address (`/<handle>/<name>[/…]`) the app has not resolved yet: asks
// the platform which repository it names, remembers that, and shows the same page under the
// repository's id route (whose address is now the readable one). Unknown or private to this
// viewer: the repository not-found page.
import { useEffect } from 'react';
import type { Navigate } from '../shell/useRoute';
import { RepoNotFound, repoMissing } from './RepoNotFound';
import { type NamedRoute, rememberRepoName } from './repoNames';
import { Failure, Loading } from './SourceStatus';
import { parseSourceRoute } from './sourceRoute';
import { useSource } from './useSource';

/** `GET /resolve/<handle>/<name>`: an earlier name answers with the current one. */
type Resolved = { id: string; handle: string; name: string; path: string };

export const resolvePath = (owner: string, name: string) =>
  `/resolve/${owner}/${encodeURIComponent(name)}`;

export function RepoByName({
  route,
  navigate,
  authenticated,
  onSignIn,
  onNew,
}: {
  route: Extract<NamedRoute, { view: 'repo-name' }>;
  navigate: Navigate;
  authenticated: boolean;
  onSignIn: () => void;
  onNew: () => void;
}) {
  const found = useSource<Resolved>(resolvePath(route.owner, route.name));
  const id = found.data?.id;
  // biome-ignore lint/correctness/useExhaustiveDependencies: once per resolved repository.
  useEffect(() => {
    if (!found.data || !id) return;
    rememberRepoName(id, found.data.handle, found.data.name);
    const rest = route.rest ? `/${route.rest}` : '';
    navigate(parseSourceRoute(`/source/${id}${rest}`, route.search), { replace: true });
  }, [id]);
  if (repoMissing(found.code))
    return (
      <RepoNotFound
        navigate={navigate}
        onNew={onNew}
        authenticated={authenticated}
        onSignIn={onSignIn}
      />
    );
  if (found.error) return <Failure error={found.error} onRetry={found.reload} />;
  return <Loading what={`${route.owner}/${route.name}`} />;
}
