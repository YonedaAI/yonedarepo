// Agents → Sessions: every coding session recorded on the repository, newest first, one row
// per session with the commits it produced; filtered by CLI, model or branch.
import { useEffect, useId, useState } from 'react';
import { EmptyState } from '../../components/EmptyState';
import { linkTo, type Navigate } from '../shell/useRoute';
import {
  appendPage,
  groupSessions,
  NO_FILTERS,
  type SessionFilters,
  type SessionList,
  type SessionRecord,
  sessionsPath,
  summaryText,
  transcriptLabel,
} from './agentModel';
import { PageToolbar } from './PageToolbar';
import { usePeople } from './people';
import { Failure, Loading } from './SourceStatus';
import { shortSha, sourceApi, when } from './sourceApi';
import { useSource } from './useSource';

/** A repository with no sessions, and how the first one appears. */
export function NoSessions() {
  return (
    <EmptyState id="sessions-heading" title="No sessions yet">
      Work with an agent and push your changes to record the first session.
    </EmptyState>
  );
}

function Filter({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: string[];
  onChange: (value: string) => void;
}) {
  const id = useId();
  return (
    <span className="agent-filter">
      <label htmlFor={id}>{label}</label>
      <select id={id} value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">All</option>
        {value && !options.includes(value) && <option value={value}>{value}</option>}
        {options.map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
      </select>
    </span>
  );
}

function SessionRow({
  repo,
  records,
  navigate,
}: {
  repo: string;
  records: SessionRecord[];
  navigate: Navigate;
}) {
  const people = usePeople();
  const s = records[0];
  const reads = records.reduce((n, r) => n + r.reads, 0);
  return (
    <li>
      <a className="agent-session-link" {...linkTo({ view: 'session', repo, id: s.id }, navigate)}>
        <span className="chip">{s.cli}</span>
        {s.model && <span className="source-meta">{s.model}</span>}
        <span className="agent-summary">{summaryText(s)}</span>
      </a>
      <span className="source-meta">
        {people.principal(s.recorded_by)} · {when(s.at)} · {reads} file
        {reads === 1 ? '' : 's'} read
        {s.transcript
          ? ` · ${transcriptLabel(s)}`
          : s.transcript_ref && (
              <>
                {' · '}
                <code>{s.transcript_ref}</code>
              </>
            )}
      </span>
      <span className="agent-commits">
        {records.length} commit{records.length === 1 ? '' : 's'}:{' '}
        {records.map((r) => (
          <a key={r.id} {...linkTo({ view: 'commit', repo, commit: r.commit }, navigate)}>
            <code>{shortSha(r.commit)}</code> {r.subject}
          </a>
        ))}
      </span>
    </li>
  );
}

export function AgentSessions({
  repo,
  branches,
  navigate,
}: {
  repo: string;
  /** Branch names to filter by. */
  branches: string[];
  navigate: Navigate;
}) {
  const [filters, setFilters] = useState<SessionFilters>(NO_FILTERS);
  const first = useSource<SessionList>(sessionsPath(repo, filters));
  // Later pages, read on demand; a new first page starts over.
  const [more, setMore] = useState<{ rows: SessionRecord[]; next: number | null } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new first page resets the rest.
  useEffect(() => {
    setMore(null);
  }, [first.data]);
  if (first.loading && !first.data) return <Loading what="sessions" />;
  if (first.error) return <Failure error={first.error} onRetry={first.reload} />;
  const data = first.data as SessionList;
  const rows = appendPage(data.sessions, more?.rows ?? [], (r) => r.id);
  const next = more ? more.next : data.next;
  const filtered = Object.values(filters).some(Boolean);
  async function loadMore() {
    setBusy(true);
    setError('');
    try {
      const page = await sourceApi<SessionList>(sessionsPath(repo, filters, next));
      setMore({ rows: appendPage(more?.rows ?? [], page.sessions, (r) => r.id), next: page.next });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const set = (key: keyof SessionFilters) => (value: string) =>
    setFilters((f) => ({ ...f, [key]: value }));
  if (rows.length === 0 && !filtered)
    return (
      <section aria-labelledby="sessions-heading">
        <NoSessions />
      </section>
    );
  return (
    <section aria-labelledby="sessions-heading">
      <PageToolbar
        title="Sessions"
        headingId="sessions-heading"
        search={{ repo, navigate }}
        filtered={[filters.cli, filters.model, filters.ref].filter(Boolean).length}
        filters={
          <>
            <Filter label="CLI" value={filters.cli} options={data.clis} onChange={set('cli')} />
            <Filter
              label="Model"
              value={filters.model}
              options={data.models}
              onChange={set('model')}
            />
            <Filter label="Branch" value={filters.ref} options={branches} onChange={set('ref')} />
          </>
        }
      />
      {data.branch_scan_truncated && (
        <p className="source-note">
          Only the newest 2,000 commits of {filters.ref} were searched for sessions.
        </p>
      )}
      {rows.length === 0 ? (
        <p className="source-empty">No sessions match these filters.</p>
      ) : (
        <ul className="agent-sessions" aria-label="Sessions" aria-busy={first.loading}>
          {groupSessions(rows).map((g) => (
            <SessionRow key={g.key} repo={repo} records={g.records} navigate={navigate} />
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
          {busy ? 'Loading…' : 'Load older sessions'}
        </button>
      )}
    </section>
  );
}
