import type { Snapshot } from '../../lib/types';
import { runAttention } from './runReviewState';
import { runTitle } from './runTitle';

export function RunHistory({
  snapshot,
  selected,
  onSelect,
}: {
  snapshot: Snapshot;
  selected: string;
  onSelect: (id: string) => void;
}) {
  return (
    <div className="run-picker">
      <label htmlFor="recorded-run">Run history</label>
      <select id="recorded-run" value={selected} onChange={(event) => onSelect(event.target.value)}>
        {[...snapshot.runs].reverse().map((run) => (
          <option key={run.id} value={run.id}>
            {runTitle(run.intent)} · {runAttention(snapshot, run).title.toLowerCase()} ·{' '}
            {new Date(run.created_at).toLocaleDateString()}
          </option>
        ))}
      </select>
    </div>
  );
}
