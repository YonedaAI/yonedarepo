import type { RunMode } from '../../../../shared/team';
export function RunModePicker({
  value,
  supported,
  locked,
  onChange,
}: {
  value: RunMode;
  supported: boolean;
  locked: boolean;
  onChange: (value: RunMode) => void;
}) {
  return (
    <fieldset className="run-mode-picker">
      <legend>How should agents work?</legend>
      <label>
        <input
          type="radio"
          name="run-mode"
          value="compare"
          checked={value === 'compare'}
          disabled={locked}
          onChange={() => onChange('compare')}
        />
        <span>
          <strong>Compare approaches</strong>
          <small>Independent attempts at the same brief. You choose what to publish.</small>
        </span>
      </label>
      <label>
        <input
          type="radio"
          name="run-mode"
          value="collaborate"
          checked={value === 'collaborate'}
          disabled={locked || !supported}
          onChange={() => onChange('collaborate')}
        />
        <span>
          <strong>Build together</strong>
          <small>Each agent takes tasks you write. One merged team result.</small>
        </span>
      </label>
      {!supported && (
        <p className="subtle">Build together runs in the sandbox, on a task list you write.</p>
      )}
    </fieldset>
  );
}
