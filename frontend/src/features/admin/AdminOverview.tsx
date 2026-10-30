// Admin overview: account, activity and repository totals, and sign-ups per day for 30 days.
import { Failure, Loading } from '../source-platform/SourceStatus';
import { useSource } from '../source-platform/useSource';
import { DayChart } from './AdminParts';
import type { Overview } from './adminModel';

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
      <DayChart
        id="admin-signups-chart"
        title="Sign-ups, last 30 days"
        unit="sign-ups"
        days={days}
      />
      <p className="source-meta">
        The index holds every sign-up since it started, and older accounts that own a repository,
        picked a handle, joined one or hold a token. Other older accounts appear when they next sign
        in.
      </p>
    </>
  );
}
