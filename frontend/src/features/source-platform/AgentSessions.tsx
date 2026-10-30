// Agents → Sessions: every coding session recorded on the repository, newest first, one row
// per session with the commits it produced; filtered by CLI, model or branch.
import { useEffect, useId, useState } from 'react';
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
import { usePeople } from './people';
import { Failure, Loading } from './SourceStatus';
import { shortSha, sourceApi, when } from './sourceApi';
import { useSource } from './useSource';

/** How sessions get here, for the empty state. */
export function HowSessionsAreRecorded() {
  return (
    <div className="source-empty-state">
      <p>
        <strong>No sessions recorded yet.</strong> A session record says which coding session
        produced a commit: the CLI, the model, a short summary and its transcript (credentials
        redacted).
      </p>
      <p>
        The Yoneda plugins for Claude Code and opencode record one for each commit pushed in a turn.
        From any other agent, after pushing:{' '}
        <code>
          yoneda session record --cli &lt;cli&gt; --summary &lt;text&gt; --model &lt;model&gt;
        </code>{' '}
        (or MCP <code>git_session_record</code>).
      </p>
    </div>
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
        {people.principal(s.recorded_by)} · {when(s.at)} · {reads} declared read
        {reads === 1 ? '' : 's'}
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
  return (
    <section aria-labelledby="sessions-heading">
      <div className="agent-head">
        <div>
          <h2 id="sessions-heading">Sessions</h2>
          <p className="agent-subtitle">
            Which coding session made each commit: the tool, the model and a short summary.
          </p>
        </div>
        <div className="agent-filters">
          <Filter label="CLI" value={filters.cli} options={data.clis} onChange={set('cli')} />
          <Filter
            label="Model"
            value={filters.model}
            options={data.models}
            onChange={set('model')}
          />
          <Filter label="Branch" value={filters.ref} options={branches} onChange={set('ref')} />
        </div>
      </div>
      {data.branch_scan_truncated && (
        <p className="source-note">
          Only the newest 2,000 commits of {filters.ref} were searched for sessions.
        </p>
      )}
      {rows.length === 0 &&
        (filtered ? (
          <p className="source-empty">No sessions match these filters.</p>
        ) : (
          <HowSessionsAreRecorded />
        ))}
      {rows.length > 0 && (
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
