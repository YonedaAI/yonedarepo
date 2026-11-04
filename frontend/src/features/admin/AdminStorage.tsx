// One repository's database size and row estimates, read only when Details opens.
import { Failure, Loading } from '../source-platform/SourceStatus';
import { useSource } from '../source-platform/useSource';
import { dbSize, type RepoDetail, repoPath } from './adminModel';

/** Row estimates shown for one repository, largest first. */
const TABLES_SHOWN = 8;

export function LiveStorage({ repo }: { repo: string }) {
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
