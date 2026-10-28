// Checks: the ones the platform runs (commands and AI checks), and who may post each
// required check that is reported from outside (CI, a reviewer bot).
import { useState } from 'react';
import {
  CHECK_NAME,
  listFromText,
  type Policy,
  postedChecks,
  type Runner,
  withPosters,
  withRequired,
  withRunner,
} from './policy';
import { RunnerEditor } from './RunnerEditor';

function AddRunner({
  taken,
  onAdd,
}: {
  taken: string[];
  onAdd: (name: string, r: Runner) => void;
}) {
  const [name, setName] = useState('');
  const [kind, setKind] = useState<'command' | 'model'>('command');
  const clash = taken.includes(name);
  function add() {
    if (!name || clash || !new RegExp(`^${CHECK_NAME}$`).test(name)) return;
    onAdd(name, kind === 'model' ? { kind: 'model', rubric: '' } : { command: [] });
    setName('');
  }
  return (
    <fieldset className="settings-add">
      <legend className="sr-only">Add a check</legend>
      <label className="source-field">
        New check name
        <input
          value={name}
          pattern={CHECK_NAME}
          placeholder="tests"
          spellCheck={false}
          onChange={(e) => setName(e.target.value.trim())}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              add();
            }
          }}
          aria-invalid={clash ? true : undefined}
        />
        {clash && <small className="settings-problem">A check named {name} exists.</small>}
      </label>
      <label className="source-field">
        Kind
        <select value={kind} onChange={(e) => setKind(e.target.value as 'command' | 'model')}>
          <option value="command">Command</option>
          <option value="model">AI check</option>
        </select>
      </label>
      <button type="button" className="quiet" disabled={!name || clash} onClick={add}>
        Add check
      </button>
    </fieldset>
  );
}

export function ChecksSettings({
  draft,
  change,
}: {
  draft: Policy;
  change: (next: Policy) => void;
}) {
  const runners = Object.entries(draft.runners ?? {});
  const posted = postedChecks(draft);
  return (
    <>
      <h3>Checks the platform runs</h3>
      <p className="source-meta">
        Defined here, never by the commit under test, so a change cannot weaken its own check. Each
        runs on the exact commit before it can land.
      </p>
      {runners.length === 0 && <p className="source-empty">No checks yet. Add one below.</p>}
      {runners.map(([name, runner]) => (
        <RunnerEditor
          key={name}
          name={name}
          runner={runner}
          required={draft.required_checks.includes(name)}
          onChange={(next) => change(withRunner(draft, name, next))}
          onRequired={(required) => change(withRequired(draft, name, required))}
          onRemove={() => change(withRequired(withRunner(draft, name, null), name, false))}
        />
      ))}
      <AddRunner
        taken={[...runners.map(([n]) => n), ...draft.required_checks]}
        onAdd={(name, runner) => change(withRequired(withRunner(draft, name, runner), name, true))}
      />
      <h3>Who may post each reported check</h3>
      <p className="source-meta">
        Required checks without a runner are posted from outside. By default only the owner may post
        one; list <code>owner</code> and <code>token:&lt;name&gt;</code> entries to allow a
        repository token (e.g. CI).
      </p>
      {posted.length === 0 ? (
        <p className="source-empty">No reported checks are required.</p>
      ) : (
        posted.map((check) => (
          <label key={check} className="source-field settings-wide">
            <span>
              Posters of <code>{check}</code>
            </span>
            <input
              defaultValue={(draft.check_posters?.[check] ?? []).join(', ')}
              placeholder="owner (default)"
              spellCheck={false}
              onChange={(e) => change(withPosters(draft, check, listFromText(e.target.value)))}
            />
          </label>
        ))
      )}
    </>
  );
}
