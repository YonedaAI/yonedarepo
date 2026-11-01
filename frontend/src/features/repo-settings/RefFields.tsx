// The fields of the Create branch and Create tag forms: a checked ref name, and the branch to
// start from.
import { shortSha } from '../source-platform/sourceApi';
import { type RefRow, refNameProblem } from './refModel';

export function RefName({
  id,
  label,
  value,
  onChange,
  placeholder,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
}) {
  const problem = value ? refNameProblem(value) : '';
  return (
    <label htmlFor={id} className="source-field">
      {label}
      <input
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value.trim())}
        placeholder={placeholder}
        autoComplete="off"
        spellCheck={false}
        aria-invalid={problem ? true : undefined}
        aria-describedby={problem ? `${id}-problem` : undefined}
        required
      />
      {problem && (
        <span id={`${id}-problem`} className="form-error">
          {problem}
        </span>
      )}
    </label>
  );
}

/** The branch to start from, as a select over the current branches. */
export function StartFrom({
  id,
  branches,
  value,
  onChange,
}: {
  id: string;
  branches: RefRow[];
  value: string;
  onChange: (branch: string) => void;
}) {
  return (
    <label htmlFor={id} className="source-field">
      From branch
      <select id={id} value={value} onChange={(e) => onChange(e.target.value)}>
        {branches.map((b) => (
          <option key={b.name} value={b.name}>
            {b.name} ({shortSha(b.commit)})
          </option>
        ))}
      </select>
    </label>
  );
}
