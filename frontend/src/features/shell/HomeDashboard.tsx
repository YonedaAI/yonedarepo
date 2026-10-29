// The signed-in Home (`/`): a greeting, the account's repository numbers, commits made or
// pushed per day and hour over the last 30 days, and the newest agent sessions across the
// account's repositories. Everything comes from `GET /api/v1/activity`.
import { Bot, Plus } from 'lucide-react';
import { Failure, Loading } from '../source-platform/SourceStatus';
import { ContributionChart } from './ContributionChart';
import { type AccountActivity, ago, contributionGrid, greeting, statCards } from './homeModel';
import { linkTo, type Navigate } from './useRoute';

function Sessions({ activity, navigate }: { activity: AccountActivity; navigate: Navigate }) {
  if (!activity.sessions.length)
    return (
      <p className="home-empty">
        No sessions recorded yet. An agent records one per commit it pushes (the Claude Code plugin
        does it for you, or <code>yoneda session record</code>).
      </p>
    );
  return (
    <ul className="home-sessions">
      {activity.sessions.map((s) => (
        <li key={`${s.repo}:${s.id}`}>
          <a {...linkTo({ view: 'session', repo: s.repo, id: s.id }, navigate)}>
            <Bot size={16} aria-hidden="true" />
            <span className="home-session-text">
              <strong>{s.summary || s.subject}</strong>
              <small>
                {s.name} · {s.cli}
                {s.model ? ` · ${s.model}` : ''}
              </small>
            </span>
            <time dateTime={new Date(s.at).toISOString()}>{ago(s.at, activity.now)}</time>
          </a>
        </li>
      ))}
    </ul>
  );
}

export function HomeDashboard({
  username,
  activity,
  loading,
  error,
  onRetry,
  navigate,
  onNew,
}: {
  username?: string;
  activity?: AccountActivity;
  loading: boolean;
  error: string;
  onRetry: () => void;
  navigate: Navigate;
  onNew: () => void;
}) {
  const hello = greeting(new Date().getHours());
  const grid = activity ? contributionGrid(activity.commits, activity.now) : undefined;
  return (
    <div className="home-dashboard">
      <header className="home-greeting">
        <div>
          <h1 id="home-heading">
            {hello}
            {username ? `, ${username}` : ''}
          </h1>
          <p>Here's an overview of your recent activity.</p>
        </div>
        <button type="button" onClick={onNew}>
          <Plus size={17} aria-hidden="true" />
          New repository
        </button>
      </header>
      {error && !activity && <Failure error={error} onRetry={onRetry} />}
      {loading && !activity && !error && <Loading what="your activity" />}
      {activity && grid && (
        <>
          {activity.pending > 0 && (
            <p className="home-pending" role="status">
              Activity for {activity.pending}{' '}
              {activity.pending === 1 ? 'repository is' : 'repositories are'} still being gathered;
              refresh in a moment.
            </p>
          )}
          <section aria-labelledby="home-repositories" className="home-section">
            <h2 id="home-repositories" className="home-label">
              Repositories
            </h2>
            <ul className="stat-cards">
              {statCards(activity).map((card) => (
                <li key={card.id} className="stat-card">
                  <span className="stat-label">{card.label}</span>
                  <span className="stat-value">{card.value.toLocaleString('en-US')}</span>
                  <span className="stat-caption">{card.caption}</span>
                </li>
              ))}
            </ul>
          </section>
          <section aria-labelledby="home-contributions" className="home-section">
            <div className="home-section-head">
              <h2 id="home-contributions" className="home-label">
                Contributions, last 30 days
              </h2>
              <span className="home-total">
                <span className="stat-number">{grid.total.toLocaleString('en-US')}</span>{' '}
                {grid.total === 1 ? 'commit' : 'commits'}
              </span>
            </div>
            <div className="home-panel">
              {grid.total ? (
                <ContributionChart grid={grid} />
              ) : (
                <p className="home-empty">
                  No commits yet. Commits pushed or landed on your repositories show here by day and
                  hour.
                </p>
              )}
            </div>
          </section>
          <section aria-labelledby="home-sessions" className="home-section">
            <h2 id="home-sessions" className="home-label">
              Sessions
            </h2>
            <div className="home-panel">
              <Sessions activity={activity} navigate={navigate} />
            </div>
          </section>
        </>
      )}
    </div>
  );
}
