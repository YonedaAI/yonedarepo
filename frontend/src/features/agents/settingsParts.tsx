// The agent settings form's trigger (when to run, which changes, path and branch filters) and
// its Repositories checklist (searchable, Select all / Unselect all).
import { useState } from 'react';
import type { Trigger } from '../../../../shared/managed-agents';
import { filterRepos, parseFilters } from './agentsModel';

export function TriggerFields({
  trigger,
  onChange,
}: {
  trigger: Trigger;
  onChange: (t: Trigger) => void;
}) {
  const [filtering, setFiltering] = useState(
    trigger.paths.length > 0 || trigger.branches.length > 0,
  );
  return (
    <fieldset className="agent-fieldset">
      <legend>Trigger</legend>
      <div className="agent-field-row">
        <label className="agent-field">
          When to run
          <select
            value={trigger.when}
            onChange={(e) => onChange({ ...trigger, when: e.target.value as Trigger['when'] })}
          >
            <option value="push">On every push</option>
            <option value="ready">When marked ready</option>
          </select>
        </label>
        <label className="agent-field">
          Changes
          <select value={trigger.changes} onChange={() => {}} aria-describedby="changes-hint">
            <option value="ready_for_review">Ready for review</option>
          </select>
        </label>
      </div>
      <p id="changes-hint" className="source-meta">
        In a repository that does not require approvals, every open change counts as ready for
        review.
      </p>
      {filtering ? (
        <div className="agent-field-row">
          <label className="agent-field">
            Paths (one per line)
            <textarea
              rows={3}
              value={trigger.paths.join('\n')}
              placeholder="src/&#10;docs/api.md"
              onChange={(e) => onChange({ ...trigger, paths: parseFilters(e.target.value) })}
            />
          </label>
          <label className="agent-field">
            Branches (one per line, <code>prefix/*</code> allowed)
            <textarea
              rows={3}
              value={trigger.branches.join('\n')}
              placeholder="feature/*"
              onChange={(e) => onChange({ ...trigger, branches: parseFilters(e.target.value) })}
            />
          </label>
        </div>
      ) : (
        <button type="button" className="text-button" onClick={() => setFiltering(true)}>
          + Add filters
        </button>
      )}
    </fieldset>
  );
}

export function RepoChecklist({
  repos,
  selected,
  onChange,
}: {
  repos: { id: string; name: string }[];
  selected: string[];
  onChange: (repos: string[]) => void;
}) {
  const [query, setQuery] = useState('');
  const shown = filterRepos(repos, query);
  const chosen = new Set(selected);
  const toggle = (id: string) =>
    onChange(chosen.has(id) ? selected.filter((r) => r !== id) : [...selected, id]);
  return (
    <fieldset className="agent-fieldset">
      <legend>Repositories</legend>
      {repos.length === 0 ? (
        <p className="source-empty">You own no repositories in this workspace yet.</p>
      ) : (
        <>
          <div className="agent-repo-tools">
            <input
              type="search"
              aria-label="Search repositories"
              placeholder="Search repositories"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            <button
              type="button"
              className="text-button"
              onClick={() => onChange(repos.map((r) => r.id))}
            >
              Select all
            </button>
            <button type="button" className="text-button" onClick={() => onChange([])}>
              Unselect all
            </button>
            <span className="source-meta">
              {selected.length} of {repos.length} selected
            </span>
          </div>
          <ul className="agent-repo-list">
            {shown.map((r) => (
              <li key={r.id}>
                <label>
                  <input type="checkbox" checked={chosen.has(r.id)} onChange={() => toggle(r.id)} />
                  {r.name}
                </label>
              </li>
            ))}
            {!shown.length && <li className="source-meta">No repository matches “{query}”.</li>}
          </ul>
        </>
      )}
    </fieldset>
  );
}
