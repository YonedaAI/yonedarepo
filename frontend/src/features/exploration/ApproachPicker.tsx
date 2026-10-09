import { useId, useState } from 'react';
import { approachPresets } from './approaches';

export function ApproachPicker({
  value,
  used,
  disabled,
  onChange,
}: {
  value: string;
  used: string[];
  disabled: boolean;
  onChange: (value: string) => void;
}) {
  const description = useId();
  const preset = approachPresets.find((option) => option.instructions === value);
  const [custom, setCustom] = useState(!preset);
  return (
    <div className="approach-picker">
      <label>
        Approach
        <select
          value={custom ? '__custom__' : (preset?.id ?? '__custom__')}
          disabled={disabled}
          aria-describedby={description}
          onChange={(event) => {
            const option = approachPresets.find((entry) => entry.id === event.target.value);
            setCustom(!option);
            if (option) onChange(option.instructions);
          }}
        >
          {approachPresets.map((option) => (
            <option key={option.id} value={option.id} disabled={used.includes(option.instructions)}>
              {option.label}
            </option>
          ))}
          <option value="__custom__">Custom approach…</option>
        </select>
      </label>
      {custom ? (
        <label>
          Custom approach
          <input
            value={value}
            onChange={(event) => onChange(event.target.value)}
            required
            maxLength={128}
            disabled={disabled}
            placeholder="Describe a different implementation or design to compare"
          />
        </label>
      ) : null}
      <p className="subtle" id={description}>
        {custom ? 'Write your own instructions or adapt a preset.' : value}
      </p>
    </div>
  );
}
