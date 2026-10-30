// Agents → Memories: what agents and people left for later coding sessions (decisions,
// constraints, gotchas, how-tos), newest first, filtered by anchored path, kind and status.
// Each names its anchors (linked to the file on main, marked when that code changed since),
// the commit it was written against and the session it came from. Writers add, supersede,
// publish a session's draft, and retire; every change appends, nothing is edited away.
import { useState } from 'react';
import { linkTo, type Navigate } from '../shell/useRoute';
import { type ComposerStart, EMPTY_COMPOSER, MemoryComposer } from './MemoryComposer';
import {
  anchorText,
  MEMORY_KINDS,
  MEMORY_STATUSES,
  type Memory,
  type MemoryFilters,
  type MemoryKind,
  type MemoryPage,
  type MemoryStatus,
  memoriesPath,
  NO_MEMORY_FILTERS,
  STATUS_LABELS,
} from './memoryModel';
import { usePeople } from './people';
import { useReadOnly } from './repoAccess';
import { Failure, Loading } from './SourceStatus';
import { shortSha, sourceApi, when } from './sourceApi';
import { useSource } from './useSource';

function Retire({ repo, memory, onDone }: { repo: string; memory: Memory; onDone: () => void }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [error, setError] = useState('');
  if (!open)
    return (
      <button type="button" className="quiet" onClick={() => setOpen(true)}>
        {memory.status === 'draft' ? 'Discard…' : 'Retire…'}
      </button>
    );
  async function retire() {
    setError('');
    try {
      await sourceApi(`/repos/${repo}/memories/${memory.id}/retire`, {
        body: { reason: reason.trim() || null },
      });
      onDone();
    } catch (e) {
      setError((e as Error).message);
    }
  }
  return (
    <span className="memory-retire">
      <input
        aria-label={`Why memory #${memory.id} no longer holds`}
        placeholder="Why it no longer holds (optional)"
        value={reason}
        onChange={(e) => setReason(e.target.value)}
      />
      <button type="button" onClick={retire}>
        Retire #{memory.id}
      </button>
      <button type="button" className="quiet" onClick={() => setOpen(false)}>
        Cancel
      </button>
      {error && (
        <span role="alert" className="source-error">
          {error}
        </span>
      )}
    </span>
  );
}

function MemoryRow({
  repo,
  memory: m,
  navigate,
  onEdit,
  onChanged,
}: {
  repo: string;
  memory: Memory;
  navigate: Navigate;
  onEdit: (start: ComposerStart) => void;
  onChanged: () => void;
}) {
  const people = usePeople();
  const readOnly = useReadOnly();
  const live = (m.status === 'active' || m.status === 'draft') && !m.quarantined;
  return (
    <li id={`memory-${m.id}`}>
      <div className="memory-chips">
        <span className="chip">{m.kind}</span>
        {m.status !== 'active' && <span className={`chip memory-${m.status}`}>{m.status}</span>}
        {m.stale && <span className="chip memory-stale">stale: the code changed since</span>}
      </div>
      {m.quarantined ? (
        <p className="source-meta">Withheld by the repository's owner (quarantine).</p>
      ) : (
        <p className="memory-text">{m.text}</p>
      )}
      {m.anchors.length > 0 && (
        <ul className="memory-anchors" aria-label={`Anchors of memory #${m.id}`}>
          {m.anchors.map((a) => (
            <li key={anchorText(a)}>
              <a
                {...linkTo(
                  { view: 'files', repo, path: a.path.replace(/\/$/, ''), ref: 'main' },
                  navigate,
                )}
              >
                <code>{anchorText(a)}</code>
              </a>
              {a.stale === true && <span className="source-meta"> · changed since</span>}
            </li>
          ))}
        </ul>
      )}
      <span className="source-meta">
        #{m.id} · {people.principal(m.author)} · {when(m.recorded_at)} · against{' '}
        <a {...linkTo({ view: 'commit', repo, commit: m.commit }, navigate)}>
          <code>{shortSha(m.commit)}</code>
        </a>
        {m.session_id && (
          <>
            {' '}
            · session <code>{m.session_id}</code>
          </>
        )}
        {m.supersedes && <> · replaces #{m.supersedes}</>}
        {m.superseded_by && <> · replaced by #{m.superseded_by}</>}
        {m.retired && (
          <>
            {' '}
            · retired by {people.principal(m.retired.by)} {when(m.retired.at)}
            {m.retired.reason ? `: ${m.retired.reason}` : ''}
          </>
        )}
      </span>
      {!readOnly && live && (
        <div className="memory-actions">
          <button
            type="button"
            className="quiet"
            onClick={() =>
              onEdit({
                kind: m.kind,
                text: m.text ?? '',
                anchors: m.anchors.map(anchorText).join(', '),
                supersedes: m.id,
                publish: m.status === 'draft',
              })
            }
          >
            {m.status === 'draft' ? 'Publish…' : 'Supersede…'}
          </button>
          <Retire repo={repo} memory={m} onDone={onChanged} />
        </div>
      )}
    </li>
  );
}

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
              {MEMORY_KINDS.map((k) => (
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
        <div className="source-empty-state">
          <p>
            <strong>No memories {filters === NO_MEMORY_FILTERS ? 'yet' : 'match'}.</strong> A memory
            is a decision, constraint, gotcha or how-to that the code does not say, anchored to the
            files or symbols it is about. Coding sessions are shown the relevant ones when they
            start, when they read those files and when a prompt matches.
          </p>
          <p>
            Agents add one with <code>yoneda memory add</code> or MCP <code>git_memory_add</code>.
          </p>
        </div>
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
