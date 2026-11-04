// Exact optional owner/visibility constraints, applied with the server's search and order.
import { type FormEvent, useState } from 'react';
import { MAX_ACCOUNT_IDENTIFIER_LENGTH } from '../../../../shared/account';
import type { RepositoryFilters } from '../../../../shared/admin-repositories';

export function RepositoryFiltersForm({
  filters,
  onApply,
}: {
  filters: RepositoryFilters;
  onApply: (next: RepositoryFilters) => void;
}) {
  const [draft, setDraft] = useState(filters);
  const count = Number(Boolean(filters.owner)) + Number(Boolean(filters.visibility));
  const apply = (event: FormEvent) => {
    event.preventDefault();
    onApply({ ...draft, owner: draft.owner.trim() });
  };
  const clear = () => {
    const empty: RepositoryFilters = { owner: '', visibility: '' };
    setDraft(empty);
    onApply(empty);
  };
  return (
    <details className="admin-repository-filters">
      <summary>Filters{count > 0 ? ` (${count})` : ''}</summary>
      <form className="org-audit-tools" aria-label="Repository filters" onSubmit={apply}>
        <label className="source-field">
          Owner
          <input
            value={draft.owner}
            placeholder="Handle or email"
            maxLength={MAX_ACCOUNT_IDENTIFIER_LENGTH}
            autoCapitalize="none"
            onChange={(event) => setDraft({ ...draft, owner: event.target.value })}
          />
        </label>
        <label className="source-field">
          Visibility
          <select
            value={draft.visibility}
            onChange={(event) =>
              setDraft({
                ...draft,
                visibility: event.target.value as RepositoryFilters['visibility'],
              })
            }
          >
            <option value="">Any</option>
            <option value="public">Public</option>
            <option value="private">Private</option>
          </select>
        </label>
        <button type="submit" className="quiet">
          Apply
        </button>
        <button type="button" className="quiet" onClick={clear}>
          Clear
        </button>
      </form>
    </details>
  );
}
