// Home (`/`): sign-in and onboarding when signed out; signed in, the activity dashboard.
import type { Session } from '../../hooks/useSession';
import { WorkspaceWelcome } from '../workspace/WorkspaceWelcome';
import { HomeDashboard } from './HomeDashboard';
import type { AccountActivity } from './homeModel';
import type { Navigate } from './useRoute';

export function HomePage({
  session,
  activity,
  activityLoading,
  activityError,
  onRetry,
  navigate,
  onNew,
}: {
  session: Session;
  activity?: AccountActivity;
  activityLoading: boolean;
  activityError: string;
  onRetry: () => void;
  navigate: Navigate;
  onNew: () => void;
}) {
  if (!session.authenticated)
    return (
      <WorkspaceWelcome
        authenticated={false}
        loading={session.loading}
        error={session.error}
        onRetry={onRetry}
        onSignedIn={() => void session.discover()}
        onNew={onNew}
      />
    );
  return (
    <HomeDashboard
      username={session.identity?.username}
      activity={activity}
      loading={activityLoading}
      error={activityError}
      onRetry={onRetry}
      navigate={navigate}
      onNew={onNew}
    />
  );
}
