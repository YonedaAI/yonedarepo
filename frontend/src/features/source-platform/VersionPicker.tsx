import { when } from './sourceApi';
import { useSource } from './useSource';

/** Picks a transaction-log version to read at (time travel), or the latest. */
export function VersionPicker({
  repo,
  at,
  onChange,
}: {
  repo: string;
  at?: number;
  onChange: (at: number | undefined) => void;
}) {
  const txlog = useSource<{
    entries: { version: number; kind: string; committed_at_ms: number }[];
    version: number;
  }>(`/repos/${repo}/txlog?limit=500`);
  return (
    <label className="source-version">
      Version
      <select
        value={at ?? ''}
        onChange={(e) => onChange(e.target.value === '' ? undefined : Number(e.target.value))}
      >
        <option value="">Latest{txlog.data ? ` (v${txlog.data.version})` : ''}</option>
        {[...(txlog.data?.entries ?? [])].reverse().map((entry) => (
          <option key={entry.version} value={entry.version}>
            v{entry.version} · {entry.kind} · {when(entry.committed_at_ms)}
          </option>
        ))}
      </select>
    </label>
  );
}
