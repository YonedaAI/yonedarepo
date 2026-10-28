// One check the platform runs itself: a command in a CheckContainer, or an AI check (one
// model review of the commit's diff against the owner's rubric).
import { useState } from 'react';
import {
  argvText,
  type CommandRunner,
  DEFAULT_TIMEOUT_SECONDS,
  isModel,
  type ModelRunner,
  parseArgv,
  REVIEW_MODELS,
  type Runner,
} from './policy';

function CommandField({
  id,
  runner,
  onChange,
}: {
  id: string;
  runner: CommandRunner;
  onChange: (next: CommandRunner) => void;
}) {
  const [text, setText] = useState(argvText(runner.command));
  const [problem, setProblem] = useState('');
  return (
    <label className="source-field settings-wide" htmlFor={id}>
      Command
      <input
        id={id}
        value={text}
        spellCheck={false}
        placeholder='cargo test   or   ["sh", "-c", "npm ci && npm test"]'
        aria-invalid={problem ? true : undefined}
        onChange={(e) => {
          setText(e.target.value);
          try {
            onChange({ ...runner, command: parseArgv(e.target.value) });
            setProblem('');
          } catch (failure) {
            setProblem((failure as Error).message);
          }
        }}
      />
      <small className={problem ? 'settings-problem' : 'subtle'}>
        {problem || 'Runs without a shell; write ["sh", "-c", "…"] for one.'}
      </small>
    </label>
  );
}

function ModelFields({
  id,
  runner,
  onChange,
}: {
  id: string;
  runner: ModelRunner;
  onChange: (next: ModelRunner) => void;
}) {
  return (
    <>
      <label className="source-field settings-wide">
        Rubric
        <textarea
          value={runner.rubric}
          rows={4}
          maxLength={8000}
          placeholder="Fail the change if it removes input validation or logs a secret."
          onChange={(e) => onChange({ ...runner, rubric: e.target.value })}
        />
      </label>
      <label className="source-field">
        Model
        <input
          list={`${id}-models`}
          value={runner.model ?? ''}
          placeholder={REVIEW_MODELS[0]}
          onChange={(e) => {
            const { model: _, ...rest } = runner;
            onChange(e.target.value ? { ...rest, model: e.target.value } : rest);
          }}
        />
        <datalist id={`${id}-models`}>
          {REVIEW_MODELS.map((m) => (
            <option key={m} value={m} />
          ))}
        </datalist>
      </label>
      <label className="settings-inline">
        <input
          type="checkbox"
          checked={runner.allow_truncated === true}
          onChange={(e) => {
            const { allow_truncated: _, ...rest } = runner;
            onChange(e.target.checked ? { ...rest, allow_truncated: true } : rest);
          }}
        />
        Review the first part of a diff too large to read whole (otherwise it fails)
      </label>
    </>
  );
}

export function RunnerEditor({
  name,
  runner,
  required,
  onChange,
  onRequired,
  onRemove,
}: {
  name: string;
  runner: Runner;
  required: boolean;
  onChange: (next: Runner) => void;
  onRequired: (required: boolean) => void;
  onRemove: () => void;
}) {
  const id = `runner-${name}`;
  return (
    <fieldset className="settings-runner" aria-labelledby={`${id}-title`}>
      <div className="settings-runner-head">
        <strong id={`${id}-title`}>
          {isModel(runner) ? 'AI check' : 'Command check'} <code>{name}</code>
        </strong>
        <label className="settings-inline">
          <input
            type="checkbox"
            checked={required}
            onChange={(e) => onRequired(e.target.checked)}
          />
          Required to land
        </label>
        <button type="button" className="quiet" onClick={onRemove}>
          Remove {name}
        </button>
      </div>
      {isModel(runner) ? (
        <ModelFields id={id} runner={runner} onChange={onChange} />
      ) : (
        <>
          <CommandField id={`${id}-command`} runner={runner} onChange={onChange} />
          <label className="source-field">
            Timeout (seconds)
            <input
              type="number"
              min={1}
              max={3600}
              value={runner.timeout_seconds ?? DEFAULT_TIMEOUT_SECONDS}
              onChange={(e) => onChange({ ...runner, timeout_seconds: Number(e.target.value) })}
            />
          </label>
        </>
      )}
    </fieldset>
  );
}
