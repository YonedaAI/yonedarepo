// The set-up form's editable parts: when it runs (when, which changes, path and branch
// filters) and its repositories (all of them including new ones, or a searchable checklist;
// with none yet, ways to make one).
import { useState } from 'react';
import type { Trigger } from '../../../../shared/managed-agents';
import { linkTo, type Navigate } from '../shell/useRoute';
import { ALL_REPOS_LABEL, READY_HELP } from './agentsModel';
import { filterRepos, parseFilters } from './setupForm';

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
    <>
      <div className="agent-panel-row agent-cols">
        <label className="agent-field">
          Run
          <select
            value={trigger.when}
            onChange={(e) => onChange({ ...trigger, when: e.target.value as Trigger['when'] })}
          >
            <option value="push">On every push</option>
            <option value="ready">When marked ready</option>
          </select>
        </label>
        <label className="agent-field">
          Which changes
          <select value={trigger.changes} onChange={() => {}} aria-describedby="changes-hint">
            <option value="ready_for_review">Ready for review</option>
          </select>
          <span id="changes-hint" className="source-meta">
            {READY_HELP}
          </span>
        </label>
      </div>
      <div className="agent-panel-row">
        {filtering ? (
          <div className="agent-cols">
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
      </div>
    </>
  );
}

/** With no repositories yet: make one here, or import one (the CLI and API do imports). */
function NoRepos({
  onNewRepository,
  navigate,
}: {
  onNewRepository?: () => void;
  navigate: Navigate;
}) {
  return (
    <div className="agent-panel-row agent-no-repos">
      <p>
        <strong>No repositories yet.</strong> The agent joins each one you create or import here,
        and any other the next time you open Agents.
      </p>
      <div className="agent-no-repos-actions">
        {onNewRepository && (
          <button type="button" className="quiet" onClick={onNewRepository}>
            Create a repository
          </button>
        )}
        <a
          className="button-link quiet"
          {...linkTo({ view: 'site', site: { page: 'docs', slug: 'guides/import' } }, navigate)}
        >
          Import from GitHub
        </a>
      </div>
    </div>
  );
}

export function RepoPicker({
  repos,
  all,
  selected,
  onChange,
  onNewRepository,
  navigate,
}: {
  repos: { id: string; name: string }[];
  /** All repositories, including new ones (the checklist is then not used). */
  all: boolean;
  selected: string[];
  onChange: (next: { all_repos: boolean; repos?: string[] }) => void;
  onNewRepository?: () => void;
  navigate: Navigate;
}) {
  const [query, setQuery] = useState('');
  const shown = filterRepos(repos, query);
  const chosen = new Set(selected);
  const toggle = (id: string) =>
    onChange({
      all_repos: false,
      repos: chosen.has(id) ? selected.filter((r) => r !== id) : [...selected, id],
    });
  return (
    <>
      <div className="agent-panel-row agent-repo-scope" role="radiogroup" aria-label="Repositories">
        <label>
          <input
            type="radio"
            name="repo-scope"
            checked={all}
            onChange={() => onChange({ all_repos: true })}
          />
          <span>
            {ALL_REPOS_LABEL}
            <span className="source-meta"> Repositories created or imported later join too.</span>
          </span>
        </label>
        <label>
          <input
            type="radio"
            name="repo-scope"
            checked={!all}
            disabled={repos.length === 0}
            onChange={() => onChange({ all_repos: false })}
          />
          <span>Only the repositories I choose</span>
        </label>
      </div>
      {repos.length === 0 ? (
        <NoRepos onNewRepository={onNewRepository} navigate={navigate} />
      ) : (
        <fieldset className="agent-panel-row agent-repo-choice" disabled={all}>
          <legend className="sr-only">Chosen repositories</legend>
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
              onClick={() => onChange({ all_repos: false, repos: [] })}
            >
              Unselect all
            </button>
            <span className="source-meta">
              {all ? repos.length : selected.length} of {repos.length} selected
            </span>
          </div>
          <ul className="agent-repo-list">
            {shown.map((r) => (
              <li key={r.id}>
                <label>
                  <input
                    type="checkbox"
                    checked={all || chosen.has(r.id)}
                    onChange={() => toggle(r.id)}
                  />
                  {r.name}
                </label>
              </li>
            ))}
            {!shown.length && <li className="source-meta">No repository matches “{query}”.</li>}
          </ul>
        </fieldset>
      )}
    </>
  );
}
