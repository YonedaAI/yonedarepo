// A profile (`/<handle>`): who it is (avatar or initial, name, handle, person or organization),
// then two tabs: Overview, the pinned or most recently active repositories as cards, and
// Repositories, every public repository as a list. An unknown handle is a not-found page.
import { Building2, Compass, GitBranch, User } from 'lucide-react';
import { Avatar } from '../shell/Avatar';
import { linkTo, type Navigate } from '../shell/useRoute';
import { ago } from '../source-platform/fileActivity';
import { PublicBadge } from '../source-platform/PublicBadge';
import { rememberRepoName } from '../source-platform/repoNames';
import { Failure, Loading } from '../source-platform/SourceStatus';
import { useSource } from '../source-platform/useSource';
import {
  type Profile,
  type ProfileRepo,
  type ProfileTab,
  profileName,
  profilePath,
  topRepos,
} from './profileModel';

const day = (ms: number) =>
  new Date(ms).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });

function RepoCard({ repo, navigate }: { repo: ProfileRepo; navigate: Navigate }) {
  return (
    <li className="profile-repo">
      <p className="profile-repo-name">
        <GitBranch size={16} aria-hidden="true" />
        <a {...linkTo({ view: 'files', repo: repo.id, path: '', ref: 'main' }, navigate)}>
          {repo.name}
        </a>
        {repo.visibility !== 'private' && <PublicBadge />}
      </p>
      {repo.description && <p className="profile-repo-description">{repo.description}</p>}
      {repo.last_landed_at != null ? (
        <p className="profile-repo-meta">
          Updated{' '}
          <time dateTime={new Date(repo.last_landed_at).toISOString()}>
            {ago(repo.last_landed_at)}
          </time>
        </p>
      ) : (
        repo.created_at != null && (
          <p className="profile-repo-meta">
            Created{' '}
            <time dateTime={new Date(repo.created_at).toISOString()}>{day(repo.created_at)}</time>
          </p>
        )
      )}
    </li>
  );
}

function NotFound({ handle, navigate }: { handle: string; navigate: Navigate }) {
  return (
    <section className="profile" aria-labelledby="profile-heading">
      <h1 id="profile-heading">No account named {handle}</h1>
      <p className="source-meta">
        There is no person or organization at this address, or it was renamed.
      </p>
      <a className="quiet profile-explore" {...linkTo({ view: 'explore' }, navigate)}>
        <Compass size={16} aria-hidden="true" /> Explore public repositories
      </a>
    </section>
  );
}

export function ProfilePage({
  handle,
  tab = 'overview',
  navigate,
}: {
  handle: string;
  tab?: ProfileTab;
  navigate: Navigate;
}) {
  const profile = useSource<Profile>(profilePath(handle));
  if (profile.code === 'NOT_FOUND') return <NotFound handle={handle} navigate={navigate} />;
  if (profile.error) return <Failure error={profile.error} onRetry={profile.reload} />;
  const p = profile.data;
  if (!p) return <Loading what={`${handle}’s profile`} />;
  const repos = p.repositories;
  // Before the cards render, so their links already carry the readable address (idempotent).
  for (const r of repos) rememberRepoName(r.id, p.handle, r.name);
  const Kind = p.kind === 'org' ? Building2 : User;
  const pinned = repos.some((r) => r.pinned);
  const shown = tab === 'overview' ? topRepos(repos) : repos;
  return (
    <section className="profile" aria-labelledby="profile-heading">
      <header className="profile-head">
        <Avatar
          name={profileName(p)}
          src={p.avatar_url}
          size={88}
          className="profile-avatar profile-initial"
        />
        <div>
          <h1 id="profile-heading">{profileName(p)}</h1>
          <p className="profile-handle">
            {profileName(p) !== p.handle && p.handle}
            <span className="profile-kind">
              <Kind size={13} aria-hidden="true" />
              {p.kind === 'org' ? 'Organization' : 'Person'}
            </span>
          </p>
        </div>
      </header>
      <nav className="profile-tabs" aria-label={`${profileName(p)}’s pages`}>
        <a
          {...linkTo({ view: 'profile', handle }, navigate)}
          aria-current={tab === 'overview' ? 'page' : undefined}
        >
          Overview
        </a>
        <a
          {...linkTo({ view: 'profile', handle, tab: 'repositories' }, navigate)}
          aria-current={tab === 'repositories' ? 'page' : undefined}
        >
          Repositories <span className="profile-count">{repos.length}</span>
        </a>
      </nav>
      <h2 className="profile-section">
        {tab === 'repositories' ? 'Repositories' : pinned ? 'Pinned' : 'Recently active'}
      </h2>
      {shown.length === 0 ? (
        <p className="source-empty">{profileName(p)} has no public repositories yet.</p>
      ) : (
        <ul
          className={
            tab === 'overview' ? 'profile-repos profile-cards' : 'profile-repos profile-list'
          }
          aria-label={tab === 'overview' ? 'Top repositories' : 'Repositories'}
        >
          {shown.map((r) => (
            <RepoCard key={r.id} repo={r} navigate={navigate} />
          ))}
        </ul>
      )}
    </section>
  );
}
