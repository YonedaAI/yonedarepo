// Agents → Memories: what agents and people left for later coding sessions (decisions,
// constraints, gotchas, how-tos and any kind a repository added), newest first, filtered by
// anchored path, kind and status.
// Each names its anchors (linked to the file on main, marked when that code changed since),
// the commit it was written against and the session it came from. Writers add, supersede,
// publish a session's draft, and retire; every change appends, nothing is edited away.
import { useState } from 'react';
import { EmptyState } from '../../components/EmptyState';
import type { Navigate } from '../shell/useRoute';
import { type ComposerStart, EMPTY_COMPOSER, MemoryComposer } from './MemoryComposer';
import { MemoryRow } from './MemoryRow';
import {
  kindOptions,
  MEMORY_STATUSES,
  type MemoryFilters,
  type MemoryKind,
  type MemoryPage,
  type MemoryStatus,
  memoriesPath,
  NO_MEMORY_FILTERS,
  STATUS_LABELS,
} from './memoryModel';
import { useReadOnly } from './repoAccess';
import { Failure, Loading } from './SourceStatus';
import { sourceApi } from './sourceApi';
import { useSource } from './useSource';

export function AgentMemories({ repo, navigate }: { repo: string; navigate: Navigate }) {
  const readOnly = useReadOnly();
  const [filters, setFilters] = useState<MemoryFilters>(NO_MEMORY_FILTERS);
  const [pathDraft, setPathDraft] = useState('');
  const [composer, setComposer] = useState<ComposerStart | null>(null);
  const first = useSource<MemoryPage>(memoriesPath(repo, filters));
  const [more, setMore] = useState<MemoryPage | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const reload = () => {
    setMore(null);
    first.reload();
  };
  const memories = [...(first.data?.memories ?? []), ...(more?.memories ?? [])];
  const next = more ? more.next : first.data?.next;
  async function loadMore() {
    setBusy(true);
    setError('');
    try {
      const page = await sourceApi<MemoryPage>(memoriesPath(repo, filters, next));
      setMore({ ...page, memories: [...(more?.memories ?? []), ...page.memories] });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const filter = (change: Partial<MemoryFilters>) => {
    setMore(null);
    setFilters({ ...filters, ...change });
  };
  const unfiltered = memoriesPath(repo, filters) === memoriesPath(repo, NO_MEMORY_FILTERS);
  const none = Boolean(first.data) && memories.length === 0 && unfiltered;
  if (none && !first.error && !composer)
    return (
      <section aria-labelledby="memories-heading">
        <EmptyState
          id="memories-heading"
          title="No memories yet"
          action={
            !readOnly && (
              <button type="button" onClick={() => setComposer(EMPTY_COMPOSER)}>
                Add a memory
              </button>
            )
          }
        >
          Agents save what the code doesn't say here, and later sessions read it.
        </EmptyState>
      </section>
    );
  // The first read of an unfiltered page shows no filters: it may answer with nothing to filter.
  if (first.loading && !first.data && unfiltered) return <Loading what="memories" />;
  return (
    <section aria-labelledby="memories-heading">
      <div className="agent-head">
        <h2 id="memories-heading">Memories</h2>
        <div className="agent-filters">
          <form
            className="agent-filter"
            onSubmit={(e) => {
              e.preventDefault();
              filter({ path: pathDraft });
            }}
          >
            <label htmlFor="memory-path">Path</label>
            <input
              id="memory-path"
              value={pathDraft}
              placeholder="src/net.rs or src/"
              onChange={(e) => setPathDraft(e.target.value)}
            />
          </form>
          <label className="agent-filter">
            Kind
            <select
              value={filters.kind}
              onChange={(e) => filter({ kind: e.target.value as '' | MemoryKind })}
            >
              <option value="">Any</option>
              {kindOptions(first.data?.kinds, filters.kind).map((k) => (
                <option key={k} value={k}>
                  {k}
                </option>
              ))}
            </select>
          </label>
          <label className="agent-filter">
            Status
            <select
              value={filters.status}
              onChange={(e) => filter({ status: e.target.value as MemoryStatus })}
            >
              {MEMORY_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {STATUS_LABELS[s]}
                </option>
              ))}
            </select>
          </label>
          {!readOnly && !composer && (
            <button type="button" onClick={() => setComposer(EMPTY_COMPOSER)}>
              Add a memory
            </button>
          )}
        </div>
      </div>
      {composer && (
        <MemoryComposer
          key={composer.supersedes ?? 'new'}
          repo={repo}
          kinds={first.data?.kinds}
          start={composer}
          onSaved={() => {
            setComposer(null);
            reload();
          }}
          onCancel={() => setComposer(null)}
        />
      )}
      {first.loading && !first.data ? (
        <Loading what="memories" />
      ) : first.error ? (
        <Failure error={first.error} onRetry={first.reload} />
      ) : memories.length === 0 ? (
        !none && <p className="source-empty">No memories match these filters.</p>
      ) : (
        <ul className="agent-list memory-list" aria-label="Memories">
          {memories.map((m) => (
            <MemoryRow
              key={m.id}
              repo={repo}
              memory={m}
              navigate={navigate}
              onEdit={setComposer}
              onChanged={reload}
            />
          ))}
        </ul>
      )}
      {error && (
        <p role="alert" className="source-error">
          {error}
        </p>
      )}
      {next && (
        <button type="button" className="quiet" disabled={busy} onClick={loadMore}>
          {busy ? 'Loading…' : 'Load older memories'}
        </button>
      )}
    </section>
  );
}
