// One globally searchable operator listing. Ordering and pagination belong to the server;
// live database details remain an explicit read, never a per-row startup fanout.
import { Fragment, useState } from 'react';
import type {
  RepositoryFilters,
  RepositoryOrder,
  RepositorySort,
} from '../../../../shared/admin-repositories';
import { linkTo, type Navigate } from '../shell/useRoute';
import { PublicBadge } from '../source-platform/PublicBadge';
import { Failure } from '../source-platform/SourceStatus';
import { PagedStatus, SearchBox } from './AdminParts';
import { RepositoryFiltersForm } from './AdminRepositoryFilters';
import { LiveStorage } from './AdminStorage';
import { dbSize, storageAlert, when } from './adminModel';
import { useRepositoryPages } from './useRepositoryPages';

const COLUMNS: { key: RepositorySort; label: string; number?: boolean }[] = [
  { key: 'name', label: 'Repository' },
  { key: 'owner', label: 'Owner' },
  { key: 'visibility', label: 'Visibility' },
  { key: 'created', label: 'Created' },
  { key: 'database', label: 'Database', number: true },
];
export function repositoryListPath(
  q: string,
  order: RepositoryOrder,
  cursor?: string,
  filters?: RepositoryFilters,
) {
  const query = new URLSearchParams({ sort: order.sort, direction: order.direction });
  if (q.trim()) query.set('q', q.trim());
  if (cursor) query.set('cursor', cursor);
  if (filters?.owner.trim()) query.set('owner', filters.owner.trim());
  if (filters?.visibility) query.set('visibility', filters.visibility);
  return `/admin/repos?${query}`;
}

function RepositoryTable({
  q,
  order,
  filters,
  onSort,
  navigate,
}: {
  q: string;
  order: RepositoryOrder;
  filters: RepositoryFilters;
  onSort: (key: RepositorySort) => void;
  navigate: Navigate;
}) {
  const paged = useRepositoryPages(repositoryListPath(q, order, undefined, filters), (cursor) =>
    repositoryListPath(q, order, cursor, filters),
  );
  const [open, setOpen] = useState<string | null>(null);
  return (
    <>
      <span className="sr-only" role="status">
        {paged.first.loading ? 'Loading repositories…' : ''}
      </span>
      {paged.partial && <Failure error="Some regions could not be read." onRetry={paged.reload} />}
      {paged.items.length > 0 && (
        <section
          className="source-table-wrap admin-repositories-wrap"
          // biome-ignore lint/a11y/noNoninteractiveTabindex: keyboard users must be able to scroll the wide table.
          tabIndex={0}
          aria-label="Repository list"
        >
          <table
            className="source-table admin-table admin-repositories"
            aria-busy={paged.first.loading}
          >
            <caption className="sr-only">
              Repositories. Database shows the last sampled SQLite size.
            </caption>
            <thead>
              <tr>
                {COLUMNS.map(({ key, label, number }) => (
                  <th
                    key={key}
                    className={number ? 'admin-num' : undefined}
                    aria-sort={
                      order.sort === key
                        ? order.direction === 'asc'
                          ? 'ascending'
                          : 'descending'
                        : 'none'
                    }
                  >
                    <button
                      type="button"
                      className="admin-sort"
                      aria-label={`Sort by ${key === 'name' ? 'repository' : key}`}
                      onClick={() => onSort(key)}
                    >
                      {label}
                      <span aria-hidden="true">
                        {order.sort === key
                          ? paged.first.loading
                            ? ' …'
                            : order.direction === 'asc'
                              ? ' ↑'
                              : ' ↓'
                          : ' ↕'}
                      </span>
                    </button>
                  </th>
                ))}
                <th>
                  <span className="sr-only">Details</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {paged.items.map((repo) => (
                <Fragment key={repo.id}>
                  <tr>
                    <td>
                      <a {...linkTo({ view: 'overview', repo: repo.id }, navigate)}>{repo.name}</a>
                      <small className="admin-sub">{repo.id}</small>
                    </td>
                    <td>
                      <a
                        {...linkTo(
                          { view: 'admin', section: 'users', account: repo.owner },
                          navigate,
                        )}
                      >
                        {repo.handle ?? repo.owner}
                      </a>
                    </td>
                    <td>{repo.visibility === 'public' ? <PublicBadge /> : 'Private'}</td>
                    <td>{when(repo.created_at)}</td>
                    <td className="admin-num">
                      {repo.db_bytes == null ? 'Unknown' : dbSize(repo.db_bytes)}
                      {storageAlert(repo.level) && (
                        <small className="admin-sub">{storageAlert(repo.level)}</small>
                      )}
                    </td>
                    <td>
                      <button
                        type="button"
                        className="quiet"
                        aria-expanded={open === repo.id}
                        aria-label={`${open === repo.id ? 'Hide' : 'Show'} ${repo.name} details`}
                        onClick={() => setOpen(open === repo.id ? null : repo.id)}
                      >
                        {open === repo.id ? 'Hide' : 'Details'}
                      </button>
                    </td>
                  </tr>
                  {open === repo.id && (
                    <tr>
                      <td colSpan={6}>
                        <div className="admin-storage-detail">
                          <LiveStorage repo={repo.id} />
                        </div>
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
            </tbody>
          </table>
        </section>
      )}
      <PagedStatus
        paged={{ ...paged, next: paged.partial ? null : paged.next }}
        what="repositories"
        empty={
          paged.partial
            ? ''
            : q || filters.owner || filters.visibility
              ? 'No repository matches.'
              : 'No repositories yet.'
        }
      />
    </>
  );
}

export function AdminRepos({ navigate }: { navigate: Navigate }) {
  const [q, setQ] = useState('');
  const [filters, setFilters] = useState<RepositoryFilters>({ owner: '', visibility: '' });
  const [order, setOrder] = useState<RepositoryOrder>({ sort: 'database', direction: 'desc' });
  const sort = (key: RepositorySort) =>
    setOrder((previous) => ({
      sort: key,
      direction:
        previous.sort === key
          ? previous.direction === 'asc'
            ? 'desc'
            : 'asc'
          : key === 'database' || key === 'created'
            ? 'desc'
            : 'asc',
    }));
  return (
    <>
      <div className="admin-repository-tools">
        <SearchBox label="Search names and owners" value={q} onSearch={setQ} />
        <RepositoryFiltersForm filters={filters} onApply={setFilters} />
      </div>
      <RepositoryTable q={q} order={order} filters={filters} onSort={sort} navigate={navigate} />
    </>
  );
}
