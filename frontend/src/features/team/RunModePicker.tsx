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
          <small>Independent solutions. Choose which one ships.</small>
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
          <small>Agents plan complementary work from your brief. One integrated result.</small>
        </span>
      </label>
      {!supported && (
        <p className="subtle">
          Build together requires an updated team-capable backend and runtime.
        </p>
      )}
    </fieldset>
  );
}
