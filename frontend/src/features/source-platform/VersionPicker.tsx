import { Failure } from './SourceStatus';
import { when } from './sourceApi';
import { useVersions } from './useVersions';
import { versionChoices } from './versionPages';

/** Picks a transaction-log version to read at (time travel), or the latest. */
export function VersionPicker({
  repo,
  at,
  onChange,
  recent,
  known,
}: {
  repo: string;
  at?: number;
  onChange: (at: number | undefined) => void;
  recent?: boolean;
  known?: number;
}) {
  const txlog = useVersions(repo, recent, known, true);
  return (
    <div className="source-version source-version-pages">
      <label className="source-version">
        Version
        <select
          value={at ?? ''}
          onChange={(e) => onChange(e.target.value === '' ? undefined : Number(e.target.value))}
        >
          <option value="">Latest{txlog.page ? ` (v${txlog.page.version})` : ''}</option>
          {versionChoices(txlog.page?.entries ?? [], at).map((entry) => (
            <option key={entry.version} value={entry.version}>
              v{entry.version}
              {entry.kind && (
                <>
                  {' '}
                  · {entry.kind} · {when(entry.committed_at_ms)}
                </>
              )}
            </option>
          ))}
        </select>
      </label>
      {txlog.newer.length > 0 && (
        <button type="button" className="quiet" disabled={txlog.loading} onClick={txlog.loadNewer}>
          Newer
        </button>
      )}
      {txlog.page?.next_before && (
        <button type="button" className="quiet" disabled={txlog.loading} onClick={txlog.loadOlder}>
          {txlog.loading ? 'Loading…' : 'Load older'}
        </button>
      )}
      {txlog.error && <Failure error={txlog.error} onRetry={txlog.reload} />}
    </div>
  );
}
