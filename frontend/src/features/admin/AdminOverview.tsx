// Admin overview: account, activity and repository totals, the Flight log's confirmed subscribers
// where NEWSLETTER is on, sign-ups per day for 30 days, and the revenue view where ADMIN_BILLING
// is on.
import type { Navigate } from '../shell/useRoute';
import { Failure, Loading } from '../source-platform/SourceStatus';
import { AdminRevenueSection } from './AdminRevenue';
import type { Overview } from './adminModel';
import { TimeChart } from './TimeChart';
import { dayBars } from './trafficModel';
import { useAdminSource } from './useAdminSource';

export function AdminOverview({ navigate }: { navigate: Navigate }) {
  const overview = useAdminSource<Overview>('/admin/overview');
  if (overview.loading && !overview.data) return <Loading what="the overview" />;
  if (overview.error || !overview.data)
    return <Failure error={overview.error ?? ''} what="the overview" onRetry={overview.reload} />;
  const { accounts, repos, suspended, newsletter, signups_per_day: days } = overview.data;
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
    ...(newsletter
      ? [{ label: 'Flight log', value: newsletter.confirmed, caption: 'confirmed subscribers' }]
      : []),
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
      <TimeChart
        id="admin-signups-chart"
        title="Sign-ups, last 30 days"
        unit="sign-ups"
        bars={dayBars(days)}
      />
      {overview.data.billing && <AdminRevenueSection navigate={navigate} />}
    </>
  );
}
