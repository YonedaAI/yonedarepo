// The pages a readable address opens (repoNames.ts): a profile (`/<handle>`), or a repository
// by handle and name (`/<handle>/<name>[/…]`) until it resolves to its id route.
import type { Navigate } from '../shell/useRoute';
import { RepoByName } from '../source-platform/RepoByName';
import type { NamedRoute } from '../source-platform/repoNames';
import { ProfilePage } from './ProfilePage';

export function ReadablePage({
  route,
  tick,
  navigate,
  authenticated,
  onSignIn,
  onNew,
}: {
  route: NamedRoute;
  /** The shell's refresh count: a refresh reads the page again. */
  tick: number;
  navigate: Navigate;
  authenticated: boolean;
  onSignIn: () => void;
  onNew: () => void;
}) {
  if (route.view === 'profile')
    return (
      <ProfilePage
        key={`${route.handle}:${tick}`}
        handle={route.handle}
        tab={route.tab}
        navigate={navigate}
      />
    );
  return (
    <RepoByName
      key={`${route.owner}/${route.name}:${tick}`}
      route={route}
      navigate={navigate}
      authenticated={authenticated}
      onSignIn={onSignIn}
      onNew={onNew}
    />
  );
}
