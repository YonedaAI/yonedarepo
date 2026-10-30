// Admin overview: account, activity and repository totals, and sign-ups per day for 30 days.
import { Failure, Loading } from '../source-platform/SourceStatus';
import { useSource } from '../source-platform/useSource';
import { barHeights, type Overview } from './adminModel';

const dayLabel = (day: string) =>
  new Date(`${day}T00:00:00Z`).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  });

export function AdminOverview() {
  const overview = useSource<Overview>('/admin/overview');
  if (overview.loading && !overview.data) return <Loading what="the overview" />;
  if (overview.error || !overview.data)
    return <Failure error={overview.error ?? ''} what="the overview" onRetry={overview.reload} />;
  const { accounts, repos, suspended, signups_per_day: days } = overview.data;
  const tiles = [
    { label: 'Accounts', value: accounts.total, caption: `${suspended} suspended` },
    { label: 'New today', value: accounts.new_24h, caption: 'last 24 hours' },
    { label: 'New this week', value: accounts.new_7d, caption: `${accounts.new_30d} in 30 days` },
    { label: 'Active', value: accounts.active_7d, caption: 'signed in, last 7 days' },
    {
      label: 'Repositories',
      value: repos.public + repos.private,
      caption: `${repos.public} public`,
    },
  ];
  const heights = barHeights(days.map((d) => d.count));
  const total = days.reduce((sum, d) => sum + d.count, 0);
  return (
    <>
      <ul className="stat-cards admin-tiles">
        {tiles.map((tile) => (
          <li key={tile.label} className="stat-card">
            <span className="stat-label">{tile.label}</span>
            <span className="stat-value">{tile.value.toLocaleString('en-US')}</span>
            <span className="stat-caption">{tile.caption}</span>
          </li>
        ))}
      </ul>
      <section className="home-section" aria-labelledby="admin-signups-chart">
        <div className="home-section-head">
          <h2 id="admin-signups-chart" className="home-label">
            Sign-ups, last 30 days
          </h2>
          <span className="home-total">
            <span className="stat-number">{total.toLocaleString('en-US')}</span> sign-ups
          </span>
        </div>
        <ol className="admin-bars">
          {days.map((d, i) => (
            <li key={d.day} title={`${dayLabel(d.day)}: ${d.count}`}>
              <span className="sr-only">
                {dayLabel(d.day)}: {d.count} sign-ups
              </span>
              <span className="admin-bar" style={{ height: `${heights[i]}%` }} aria-hidden="true" />
            </li>
          ))}
        </ol>
        <p className="admin-axis" aria-hidden="true">
          <span>{dayLabel(days[0]?.day ?? '')}</span>
          <span>{dayLabel(days.at(-1)?.day ?? '')}</span>
        </p>
      </section>
      <p className="source-meta">
        The index holds every sign-up since it started, and older accounts that own a repository,
        picked a handle, joined one or hold a token. Other older accounts appear when they next sign
        in.
      </p>
    </>
  );
}
