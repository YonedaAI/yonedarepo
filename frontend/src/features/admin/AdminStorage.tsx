// The repositories nearest the database size limit, by the size the derive job last sampled,
// and one repository's size and row estimates read live on request.
import { useState } from 'react';
import { linkTo, type Navigate } from '../shell/useRoute';
import { Failure, Loading } from '../source-platform/SourceStatus';
import { useSource } from '../source-platform/useSource';
import {
  dbSize,
  LARGEST_PATH,
  type LargeRepo,
  type RepoDetail,
  repoPath,
  storageAlert,
} from './adminModel';

/** Row estimates shown for one repository, largest first. */
const TABLES_SHOWN = 8;

function LiveStorage({ repo }: { repo: string }) {
  const detail = useSource<RepoDetail>(repoPath(repo));
  if (detail.loading && !detail.data) return <Loading what="the database size" />;
  if (detail.error || !detail.data)
    return <Failure error={detail.error ?? ''} what="the database size" onRetry={detail.reload} />;
  const { storage } = detail.data;
  if (!storage) return <p className="source-empty">The database size could not be read.</p>;
  const tables = Object.entries(storage.table_rows)
    .sort(([, a], [, b]) => b - a)
    .slice(0, TABLES_SHOWN);
  return (
    <>
      <p>Now: {dbSize(storage.db_bytes)}. Rows, estimated:</p>
      <ul className="admin-sizes">
        {tables.map(([table, rows]) => (
          <li key={table}>
            {table}: {rows.toLocaleString('en-US')}
          </li>
        ))}
      </ul>
    </>
  );
}

function Row({
  repo,
  open,
  onToggle,
  navigate,
}: {
  repo: LargeRepo;
  open: boolean;
  onToggle: () => void;
  navigate: Navigate;
}) {
  const alert = storageAlert(repo.level);
  return (
    <>
      <tr>
        <td>
          <a {...linkTo({ view: 'files', repo: repo.id, path: '', ref: 'main' }, navigate)}>
            {repo.name}
          </a>
          <small className="admin-sub">{repo.id}</small>
        </td>
        <td>{repo.handle ?? repo.owner}</td>
        <td>{dbSize(repo.db_bytes)}</td>
        <td>{alert && <span className="admin-status admin-status-suspended">{alert}</span>}</td>
        <td>
          <button type="button" className="quiet" aria-expanded={open} onClick={onToggle}>
            {open ? 'Hide' : 'Details'}
          </button>
        </td>
      </tr>
      {open && (
        <tr>
          <td colSpan={5}>
            <LiveStorage repo={repo.id} />
          </td>
        </tr>
      )}
    </>
  );
}

export function LargestRepos({ navigate }: { navigate: Navigate }) {
  const largest = useSource<{ items: LargeRepo[] }>(LARGEST_PATH);
  const [open, setOpen] = useState<string | null>(null);
  const items = largest.data?.items ?? [];
  return (
    <section className="home-section" aria-labelledby="admin-largest">
      <h2 id="admin-largest" className="home-label">
        Largest repositories
      </h2>
      {largest.loading && !largest.data && <Loading what="repository sizes" />}
      {largest.error && (
        <Failure error={largest.error} what="repository sizes" onRetry={largest.reload} />
      )}
      {largest.data && items.length === 0 && (
        <p className="source-empty">No repository size has been sampled yet.</p>
      )}
      {items.length > 0 && (
        <div className="source-table-wrap">
          <table className="source-table admin-table">
            <caption className="sr-only">Repositories by database size, largest first</caption>
            <thead>
              <tr>
                <th>Repository</th>
                <th>Owner</th>
                <th>Database</th>
                <th>Alert</th>
                <th aria-label="Details" />
              </tr>
            </thead>
            <tbody>
              {items.map((repo) => (
                <Row
                  key={repo.id}
                  repo={repo}
                  open={open === repo.id}
                  onToggle={() => setOpen(open === repo.id ? null : repo.id)}
                  navigate={navigate}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
