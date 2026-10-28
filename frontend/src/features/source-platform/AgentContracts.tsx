// Agents → Contracts: the authored contracts agents recorded, per symbol, newest first. A
// symbol's record history opens on demand, with whether its latest record still governs the
// symbol on main (authored) or the symbol has changed since (stale).
import { useState } from 'react';
import { linkTo, type Navigate } from '../shell/useRoute';
import {
  appendPage,
  type ContractGroup,
  type ContractRecord,
  groupContracts,
  recorder,
} from './agentModel';
import { Failure, Loading } from './SourceStatus';
import { shortSha, sourceApi, when } from './sourceApi';
import { useSource } from './useSource';

type Page = { records: ContractRecord[]; next: number | null };

/** The contract status of a symbol on main, read when its row opens. */
function StatusOnMain({ repo, group }: { repo: string; group: ContractGroup }) {
  const query = new URLSearchParams({ path: group.path, symbol: group.symbol, ref: 'main' });
  const status = useSource<{ status: 'authored' | 'derived' | 'stale' }>(
    `/repos/${repo}/contract?${query}`,
  );
  if (status.loading) return <span className="source-meta">checking main…</span>;
  if (status.error) return <span className="source-meta">not on main ({status.error})</span>;
  const text = {
    authored: 'governs the symbol on main',
    stale: 'stale: the symbol changed on main since',
    derived: 'no authored contract applies on main',
  }[status.data?.status ?? 'derived'];
  return <span className={`chip agent-contract-${status.data?.status}`}>{text}</span>;
}

function ContractRow({
  repo,
  group,
  navigate,
}: {
  repo: string;
  group: ContractGroup;
  navigate: Navigate;
}) {
  const [open, setOpen] = useState(false);
  const latest = group.records[0];
  return (
    <li>
      <details onToggle={(e) => setOpen(e.currentTarget.open)}>
        <summary>
          <code>
            {group.path} · {group.symbol}
          </code>
          <span className="agent-summary">{latest.contract.summary ?? '(no summary)'}</span>
          <span className="source-meta">
            {group.records.length} record{group.records.length === 1 ? '' : 's'} · latest by{' '}
            {recorder(latest.recorded_by)} · {when(latest.recorded_at)}
          </span>
        </summary>
        {open && <StatusOnMain repo={repo} group={group} />}
        <ol className="agent-contract-records">
          {group.records.map((r) => (
            <li key={r.seq}>
              <span className="source-meta">
                #{r.seq} · v{r.recorded_version} · against{' '}
                <a {...linkTo({ view: 'commit', repo, commit: r.commit }, navigate)}>
                  <code>{shortSha(r.commit)}</code>
                </a>{' '}
                · {recorder(r.recorded_by)}
              </span>
              <pre>{JSON.stringify(r.contract, null, 2)}</pre>
            </li>
          ))}
        </ol>
      </details>
    </li>
  );
}

export function AgentContracts({ repo, navigate }: { repo: string; navigate: Navigate }) {
  const first = useSource<Page>(`/repos/${repo}/contracts`);
  const [more, setMore] = useState<Page | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  if (first.loading && !first.data) return <Loading what="contracts" />;
  if (first.error) return <Failure error={first.error} onRetry={first.reload} />;
  const data = first.data as Page;
  const records = appendPage(data.records, more?.records ?? [], (r) => r.seq);
  const next = more ? more.next : data.next;
  async function loadMore() {
    setBusy(true);
    setError('');
    try {
      const page = await sourceApi<Page>(`/repos/${repo}/contracts?before=${next}`);
      setMore({
        records: appendPage(more?.records ?? [], page.records, (r) => r.seq),
        next: page.next,
      });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section aria-labelledby="contracts-heading">
      <h2 id="contracts-heading">Symbol contracts</h2>
      {records.length === 0 ? (
        <div className="source-empty-state">
          <p>
            <strong>No contracts recorded yet.</strong> A contract states a symbol's inputs,
            outputs, effects, errors and invariants, bound to the symbol as it was when recorded.
          </p>
          <p>
            Agents record one with MCP <code>symbol_contract_record</code> (a handle from{' '}
            <code>symbol_get</code>) or <code>POST /contracts</code>.
          </p>
        </div>
      ) : (
        <ul className="agent-contracts" aria-label="Contracts">
          {groupContracts(records).map((g) => (
            <ContractRow key={`${g.path}:${g.symbol}`} repo={repo} group={g} navigate={navigate} />
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
          {busy ? 'Loading…' : 'Load older contracts'}
        </button>
      )}
    </section>
  );
}
