// A repository's front page: the latest commit, the way to its files, the past month's activity,
// who wrote it and its README. A repository with no commits yet gets the Files page's first steps.
import { ChevronRight } from 'lucide-react';
import type { ReactNode } from 'react';
import { useNearViewport } from '../../hooks/useNearViewport';
import { TimeChart } from '../admin/TimeChart';
import { Avatar, avatarOf } from '../shell/Avatar';
import { linkTo, type Navigate } from '../shell/useRoute';
import { BranchPicker, CloneButton, LatestCommit } from './CodeParts';
import { useListing } from './codeData';
import { currentApiOrigin } from './connect';
import { type OverviewData, overviewActivityPath } from './overviewBootstrap';
import {
  activityBars,
  type Contributor,
  contributors,
  logCut,
  MONTH_DAYS,
  OVERVIEW_COMMITS,
  type OverviewCommit,
} from './overviewModel';
import { PageToolbar } from './PageToolbar';
import { usePeople } from './people';
import { findReadme, Readme } from './Readme';
import { RepoFiles } from './RepoFiles';
import type { RepoStatus } from './repoStatus';
import { repositoryContentScope } from './repositoryContentScope';
import { Failure, Loading } from './SourceStatus';
import { useSource } from './useSource';

const SHOWN_PEOPLE = 6;

function Contributors({ people, cut }: { people: Contributor[]; cut: boolean }) {
  const names = usePeople();
  return (
    <section className="home-section" aria-labelledby="overview-people">
      <div className="home-section-head">
        <h2 id="overview-people" className="home-label">
          Contributors
        </h2>
        <span className="home-total">
          <span className="stat-number">{people.length}</span>
        </span>
      </div>
      <ul className="overview-people">
        {people.slice(0, SHOWN_PEOPLE).map((person) => {
          const name = person.name ?? names.principal(person.principal);
          return (
            <li key={person.key}>
              <Avatar name={name} src={avatarOf(person.principal)} size={20} />
              <span className="overview-person">{name}</span>
              <span className="stat-number">{person.commits}</span>
            </li>
          );
        })}
      </ul>
      {cut && <p className="source-meta">From the newest {OVERVIEW_COMMITS} commits.</p>}
    </section>
  );
}

function Activity({ commits }: { commits: OverviewCommit[] }) {
  const bars = activityBars(commits);
  if (bars.every((bar) => bar.value === 0))
    return (
      <section className="home-section" aria-labelledby="overview-activity">
        <div className="home-section-head">
          <h2 id="overview-activity" className="home-label">
            Activity, past month
          </h2>
        </div>
        <p className="source-meta">No commits in the past month.</p>
      </section>
    );
  return (
    <TimeChart
      id="overview-activity"
      title={
        bars.length < MONTH_DAYS
          ? `Activity, newest ${OVERVIEW_COMMITS} commits`
          : 'Activity, past month'
      }
      unit="commits"
      bars={bars}
    />
  );
}

function OverviewActivity({
  repo,
  refName,
  preloaded,
  request,
}: {
  repo: string;
  refName: string;
  preloaded?: { commits: OverviewCommit[] };
  request?: OverviewData['activity_request'];
}) {
  const activity = useNearViewport<HTMLDivElement>();
  const log = useSource<{ commits: OverviewCommit[] }>(
    !preloaded && activity.near ? overviewActivityPath(repo, refName, request) : null,
  );
  const commits = preloaded?.commits ?? log.data?.commits;
  return (
    <div className={`overview-numbers${request ? ' is-deferred' : ''}`} ref={activity.ref}>
      {log.error && <Failure error={log.error} what="activity" onRetry={log.reload} />}
      {!commits && !log.error && <Loading what="activity" />}
      {commits &&
        (commits.length ? (
          <>
            <Activity commits={commits} />
            <Contributors people={contributors(commits)} cut={logCut(commits)} />
          </>
        ) : (
          <p className="source-meta">No activity yet.</p>
        ))}
    </div>
  );
}

export function RepoOverview({
  repo,
  refName,
  status,
  facts,
  navigate,
  account,
  bootstrap,
  waiting = false,
  onRetry,
}: {
  repo: string;
  /** The branch on show. */
  refName: string;
  status: RepoStatus;
  /** The row saying what this repository is (RepoFacts). */
  facts: ReactNode;
  navigate: Navigate;
  account?: string;
  bootstrap?: OverviewData;
  waiting?: boolean;
  onRetry?: () => void;
}) {
  const ordinary = useListing(repo, bootstrap || waiting ? undefined : refName, '');
  const listing = bootstrap
    ? {
        value: bootstrap.tree ? { kind: 'tree' as const, ...bootstrap.tree } : undefined,
        empty: bootstrap.empty,
        error: bootstrap.errors?.tree?.message,
        reload: onRetry,
      }
    : waiting
      ? {}
      : ordinary;
  const files = { view: 'files', repo, path: '', ref: refName } as const;
  if (listing.empty)
    return (
      <>
        {facts}
        <RepoFiles
          route={files}
          status={status}
          navigate={navigate}
          account={account}
          initialEmpty={bootstrap?.empty}
        />
      </>
    );
  const tree = listing.value?.kind === 'tree' ? listing.value : undefined;
  const readme = tree && findReadme(tree.entries);
  const scope = repositoryContentScope(status);
  return (
    <section className="repo-overview" aria-label="Overview">
      <PageToolbar
        view={
          <>
            <BranchPicker
              refs={status.refs ?? []}
              value={refName}
              onChange={(ref) => navigate({ view: 'overview', repo, ref })}
            />
            {facts}
          </>
        }
        search={{ repo, navigate }}
        primary={
          <CloneButton
            repo={repo}
            name={status.name}
            origin={currentApiOrigin()}
            visibility={status.visibility}
          />
        }
      />
      {listing.error && <Failure error={listing.error} onRetry={listing.reload} />}
      {!listing.value && !listing.error && <Loading what="files" />}
      {listing.value && (
        <div className="overview-latest">
          {bootstrap?.errors?.latest ? (
            <Failure
              error={bootstrap.errors.latest.message}
              what="the latest commit"
              onRetry={onRetry}
            />
          ) : (
            <LatestCommit
              repo={repo}
              commit={listing.value.commit}
              preloaded={bootstrap?.latest ?? undefined}
              commitLink={(commit, children) => (
                <a {...linkTo({ view: 'commit', repo, commit }, navigate)}>{children}</a>
              )}
            />
          )}
          <a className="overview-all-files" {...linkTo(files, navigate)}>
            View all files
            <ChevronRight size={16} aria-hidden="true" />
          </a>
        </div>
      )}
      {tree &&
        (bootstrap?.errors?.activity ? (
          <Failure error={bootstrap.errors.activity.message} what="activity" onRetry={onRetry} />
        ) : (
          <OverviewActivity
            key={`${repo}:${refName}:${bootstrap?.activity_request?.from ?? ''}:${bootstrap?.activity_request?.at ?? ''}`}
            repo={repo}
            refName={refName}
            preloaded={bootstrap?.activity ?? undefined}
            request={bootstrap?.activity_request}
          />
        ))}
      {bootstrap?.errors?.readme ? (
        <Failure error={bootstrap.errors.readme.message} what="README" onRetry={onRetry} />
      ) : bootstrap ? (
        bootstrap.readme && (
          <Readme
            repo={repo}
            scope={scope}
            ref={bootstrap.readme.commit}
            path={bootstrap.readme.path}
            preloaded={bootstrap.readme}
          />
        )
      ) : (
        readme && tree && <Readme repo={repo} scope={scope} ref={tree.commit} path={readme.name} />
      )}
    </section>
  );
}
