// One account for operators: who it is (with its contact email, shown only here), its
// repositories, tokens and credit, and the safe actions (suspend or unsuspend, grant credit),
// each confirmed first and recorded in the audit log by the server.
import { ArrowLeft } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { Dialog } from '../../components/Dialog';
import { linkTo, type Navigate } from '../shell/useRoute';
import { PublicBadge } from '../source-platform/PublicBadge';
import { Failure, Loading } from '../source-platform/SourceStatus';
import { sourceApi } from '../source-platform/sourceApi';
import { useSource } from '../source-platform/useSource';
import { type AccountDetail, accountPath, providerLabel, usd, when } from './adminModel';

type Action = { kind: 'suspend' | 'unsuspend' } | { kind: 'credit'; usd: number; note: string };

function confirmText(action: Action, name: string) {
  if (action.kind === 'credit')
    return `Grant ${name} $${action.usd.toFixed(2)} of agent credit${action.note ? ` (${action.note})` : ''}?`;
  if (action.kind === 'suspend')
    return `Suspend ${name}? Their sessions, tokens, SSH keys and Git access stop working until you unsuspend them. Nothing is deleted.`;
  return `Unsuspend ${name}? Their credentials work again.`;
}

export function AdminUser({
  account,
  self,
  navigate,
}: {
  account: string;
  /** The operator's own account (it cannot suspend itself). */
  self?: string;
  navigate: Navigate;
}) {
  const detail = useSource<AccountDetail>(accountPath(account));
  const [pending, setPending] = useState<Action | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState('');
  const [amount, setAmount] = useState('5');
  const [note, setNote] = useState('');
  const back = (
    <a className="admin-back" {...linkTo({ view: 'admin', section: 'users' }, navigate)}>
      <ArrowLeft size={15} aria-hidden="true" /> All users
    </a>
  );
  if (detail.loading && !detail.data)
    return (
      <>
        {back}
        <Loading what="the account" />
      </>
    );
  if (detail.error || !detail.data)
    return (
      <>
        {back}
        <Failure error={detail.error ?? ''} what="the account" onRetry={detail.reload} />
      </>
    );
  const a = detail.data;
  const name = a.handle ?? a.account;
  async function run(action: Action) {
    setBusy(true);
    setError('');
    try {
      const path = `${accountPath(account)}/${action.kind}`;
      await sourceApi(path, {
        method: 'POST',
        body: action.kind === 'credit' ? { usd: action.usd, note: action.note } : {},
      });
      setDone(
        action.kind === 'credit'
          ? `Granted $${action.usd.toFixed(2)}.`
          : action.kind === 'suspend'
            ? `${name} is suspended.`
            : `${name} is active again.`,
      );
      setPending(null);
      detail.reload();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const grant = (event: FormEvent) => {
    event.preventDefault();
    const value = Number(amount);
    if (!Number.isFinite(value) || value <= 0 || value > 1000) {
      setError('Enter an amount from $0.01 to $1,000.');
      return;
    }
    setError('');
    setPending({ kind: 'credit', usd: value, note: note.trim() });
  };
  const suspended = a.suspended_at !== null;
  return (
    <>
      {back}
      <div className="admin-user-head">
        <h2>{name}</h2>
        {suspended ? (
          <span className="admin-status admin-status-suspended">
            Suspended {when(a.suspended_at)}
          </span>
        ) : (
          <span className="admin-status">Active</span>
        )}
      </div>
      {done && (
        <p role="status" className="admin-done">
          {done}
        </p>
      )}
      {error && !pending && <Failure error={error} />}
      <dl className="admin-facts">
        <dt>Account</dt>
        <dd>{a.account}</dd>
        <dt>Email</dt>
        <dd>{a.email ?? 'none'}</dd>
        <dt>Sign-in</dt>
        <dd>
          {[...a.providers.map(providerLabel), ...(a.password ? ['Password'] : [])].join(', ') ||
            'none'}
        </dd>
        <dt>Created</dt>
        <dd>{when(a.created_at)}</dd>
        <dt>Last seen</dt>
        <dd>{when(a.last_seen_at)}</dd>
        <dt>Organizations</dt>
        <dd>{a.orgs.length ? a.orgs.join(', ') : 'none'}</dd>
        <dt>Personal tokens</dt>
        <dd>{a.tokens ?? 'unknown'}</dd>
        <dt>Agent credit</dt>
        <dd>{a.credit ? usd(a.credit.balance.balance) : 'not reachable from this platform'}</dd>
      </dl>
      <section className="home-section" aria-labelledby="admin-user-actions">
        <h3 id="admin-user-actions" className="home-label">
          Actions
        </h3>
        <div className="admin-actions">
          {suspended ? (
            <button
              type="button"
              className="quiet"
              onClick={() => setPending({ kind: 'unsuspend' })}
            >
              Unsuspend
            </button>
          ) : (
            <button
              type="button"
              className="danger"
              disabled={a.account === self}
              title={a.account === self ? 'You cannot suspend your own account' : undefined}
              onClick={() => setPending({ kind: 'suspend' })}
            >
              Suspend
            </button>
          )}
          <form className="admin-credit" onSubmit={grant}>
            <label>
              Credit (USD)
              <input
                type="number"
                min="0.01"
                max="1000"
                step="0.01"
                value={amount}
                onChange={(event) => setAmount(event.target.value)}
              />
            </label>
            <label>
              Note
              <input
                type="text"
                maxLength={200}
                value={note}
                placeholder="Why (shown in the ledger)"
                onChange={(event) => setNote(event.target.value)}
              />
            </label>
            <button type="submit" className="quiet" disabled={!a.credit}>
              Grant credit
            </button>
          </form>
        </div>
      </section>
      {a.credit && a.credit.entries.length > 0 && (
        <section className="home-section" aria-labelledby="admin-user-ledger">
          <h3 id="admin-user-ledger" className="home-label">
            Latest ledger entries
          </h3>
          <div className="source-table-wrap">
            <table className="source-table admin-table">
              <thead>
                <tr>
                  <th>When</th>
                  <th>Kind</th>
                  <th>Amount</th>
                  <th>Note</th>
                </tr>
              </thead>
              <tbody>
                {a.credit.entries.map((e) => (
                  <tr key={e.id}>
                    <td>{when(e.at)}</td>
                    <td>{e.kind}</td>
                    <td>{usd(e.amount)}</td>
                    <td>{e.note ?? ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
      <section className="home-section" aria-labelledby="admin-user-repos">
        <h3 id="admin-user-repos" className="home-label">
          Repositories
        </h3>
        {a.repos.length ? (
          <ul className="admin-feed">
            {a.repos.map((r) => (
              <li key={r.id}>
                <a {...linkTo({ view: 'files', repo: r.id, path: '', ref: 'main' }, navigate)}>
                  {r.name}
                </a>
                {r.visibility === 'public' && <PublicBadge />}
                <span className="admin-sub">created {when(r.created_at)}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="source-empty">No repositories.</p>
        )}
      </section>
      {pending && (
        <Dialog title="Confirm" onClose={() => setPending(null)} locked={busy}>
          <p>{confirmText(pending, name)}</p>
          {error && <Failure error={error} />}
          <div className="admin-dialog-actions">
            <button
              type="button"
              className="quiet"
              disabled={busy}
              onClick={() => setPending(null)}
            >
              Cancel
            </button>
            <button
              type="button"
              className={pending.kind === 'suspend' ? 'danger' : undefined}
              disabled={busy}
              onClick={() => run(pending)}
            >
              {busy ? 'Working…' : 'Confirm'}
            </button>
          </div>
        </Dialog>
      )}
    </>
  );
}
