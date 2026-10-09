import { runTitle } from './runTitle';

export function RunHistory({
  runs,
  selected,
  onSelect,
}: {
  runs: Record<string, any>[];
  selected: string;
  onSelect: (id: string) => void;
}) {
  return (
    <div className="run-picker">
      <label htmlFor="recorded-run">Run history</label>
      <select id="recorded-run" value={selected} onChange={(event) => onSelect(event.target.value)}>
        {[...runs].reverse().map((run) => (
          <option key={run.id} value={run.id}>
            {runTitle(run.intent)} · {run.status} · {new Date(run.created_at).toLocaleDateString()}
          </option>
        ))}
      </select>
    </div>
  );
}
