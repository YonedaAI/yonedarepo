// A repository's front page: the latest commit, the way to its files, the past month's activity,
// who wrote it and its README. A repository with no commits yet gets the Files page's first steps.
import { ChevronRight } from 'lucide-react';
import type { ReactNode } from 'react';
import { TimeChart } from '../admin/TimeChart';
import { Avatar, avatarOf } from '../shell/Avatar';
import { linkTo, type Navigate } from '../shell/useRoute';
import { CloneButton, LatestCommit } from './CodeParts';
import { useListing } from './codeData';
import type { LogCommit } from './commitLog';
import { currentApiOrigin } from './connect';
import {
  activityBars,
  type Contributor,
  contributors,
  logCut,
  MONTH_DAYS,
  OVERVIEW_COMMITS,
} from './overviewModel';
import { PageToolbar } from './PageToolbar';
import { usePeople } from './people';
import { findReadme, Readme } from './Readme';
import { RepoFiles } from './RepoFiles';
import type { RepoStatus } from './repoStatus';
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

function Activity({ commits }: { commits: LogCommit[] }) {
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

export function RepoOverview({
  repo,
  status,
  facts,
  navigate,
  account,
}: {
  repo: string;
  status: RepoStatus;
  /** The row saying what this repository is (RepoFacts). */
  facts: ReactNode;
  navigate: Navigate;
  account?: string;
}) {
  const listing = useListing(repo, 'main', '');
  const log = useSource<{ commits: LogCommit[] }>(
    `/repos/${repo}/log?ref=main&limit=${OVERVIEW_COMMITS}`,
  );
  const files = { view: 'files', repo, path: '', ref: 'main' } as const;
  if (listing.empty)
    return (
      <>
        {facts}
        <RepoFiles route={files} status={status} navigate={navigate} account={account} />
      </>
    );
  const tree = listing.value?.kind === 'tree' ? listing.value : undefined;
  const readme = tree && findReadme(tree.entries);
  const commits = log.data?.commits;
  return (
    <section className="repo-overview" aria-label="Overview">
      <PageToolbar
        view={facts}
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
          <LatestCommit
            repo={repo}
            commit={listing.value.commit}
            commitLink={(commit, children) => (
              <a {...linkTo({ view: 'commit', repo, commit }, navigate)}>{children}</a>
            )}
          />
          <a className="overview-all-files" {...linkTo(files, navigate)}>
            View all files
            <ChevronRight size={16} aria-hidden="true" />
          </a>
        </div>
      )}
      <div className="overview-numbers">
        {log.error && <Failure error={log.error} what="activity" onRetry={log.reload} />}
        {!log.data && !log.error && <Loading what="activity" />}
        {commits && <Activity commits={commits} />}
        {commits && <Contributors people={contributors(commits)} cut={logCut(commits)} />}
      </div>
      {readme && <Readme repo={repo} ref="main" path={readme.name} />}
    </section>
  );
}
