// The operator log. With OPERATOR_AUDIT on the server says so in its answer, and the page offers
// People and System, filters, and a row that opens to show the request behind it.
import { type FormEvent, Fragment, useEffect, useState } from 'react';
import { PagedStatus, usePaged } from './AdminParts';
import {
  type AuditEntry,
  type AuditFilters,
  auditPath,
  NO_FILTERS,
  OUTCOMES,
  when,
} from './adminModel';

const actorName = (actor: string) => (actor === '_admin' ? 'owner token' : actor);
const detailText = (detail: AuditEntry['detail']) =>
  detail
    ? Object.entries(detail)
        .map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : String(v)}`)
        .join(', ')
    : '';

function Outcome({ outcome }: { outcome: string }) {
  const failed = outcome === 'failed' || outcome === 'denied';
  return (
    <span className={`admin-status${failed ? ' admin-status-suspended' : ''}`}>
      {OUTCOMES[outcome] ?? outcome}
    </span>
  );
}

function Panel({ entry: e }: { entry: AuditEntry }) {
  const rows: [string, string][] = [
    ['Operator', actorName(e.actor)],
    ['Outcome', OUTCOMES[e.outcome ?? ''] ?? e.outcome ?? ''],
    ['Request', e.request_id ?? 'Not recorded'],
    ['From', e.origin === 'script' ? 'A script' : (e.origin ?? 'Not recorded')],
    ['Time zone', e.time_zone ?? 'Not recorded'],
    ['Detail', detailText(e.detail) || 'None'],
  ];
  return (
    <dl className="admin-audit-panel">
      {rows.map(([name, value]) => (
        <div key={name}>
          <dt>{name}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function Row({
  entry: e,
  detailed,
  open,
  onToggle,
}: {
  entry: AuditEntry;
  detailed: boolean;
  open: boolean;
  onToggle: () => void;
}) {
  return (
    <>
      <tr>
        <td>
          {detailed ? (
            <button
              type="button"
              className="admin-audit-open"
              aria-expanded={open}
              onClick={onToggle}
            >
              {when(e.at)}
            </button>
          ) : (
            when(e.at)
          )}
        </td>
        <td>{actorName(e.actor)}</td>
        <td>{e.action}</td>
        <td>{e.target}</td>
        {detailed ? (
          <td>
            <Outcome outcome={e.outcome ?? 'success'} />
          </td>
        ) : (
          <td className="admin-detail">{detailText(e.detail)}</td>
        )}
      </tr>
      {open && (
        <tr>
          <td colSpan={5}>
            <Panel entry={e} />
          </td>
        </tr>
      )}
    </>
  );
}

function Log({
  filters,
  onDetailed,
}: {
  filters: AuditFilters;
  onDetailed: (detailed: boolean) => void;
}) {
  const paged = usePaged<AuditEntry>((before) => auditPath(filters, before));
  const [opened, setOpened] = useState<number | null>(null);
  const detailed = (paged.first.data as { detailed?: boolean } | undefined)?.detailed === true;
  useEffect(() => {
    onDetailed(detailed);
  }, [detailed, onDetailed]);
  const filtered = JSON.stringify(filters) !== JSON.stringify(NO_FILTERS);
  return (
    <>
      {paged.items.length > 0 && (
        <div className="source-table-wrap">
          <table className="source-table admin-table">
            <caption className="sr-only">Operator actions, newest first</caption>
            <thead>
              <tr>
                <th>When</th>
                <th>Operator</th>
                <th>Action</th>
                <th>Target</th>
                <th>{detailed ? 'Outcome' : 'Detail'}</th>
              </tr>
            </thead>
            <tbody>
              {paged.items.map((e) => (
                <Fragment key={e.id}>
                  <Row
                    entry={e}
                    detailed={detailed}
                    open={opened === e.id}
                    onToggle={() => setOpened(opened === e.id ? null : e.id)}
                  />
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <PagedStatus
        paged={paged}
        what="the audit log"
        empty={filtered ? 'No actions match these filters.' : 'No operator actions yet.'}
      />
    </>
  );
}

const TEXT_FILTERS = [
  ['actor', 'Operator'],
  ['action', 'Action'],
  ['target', 'Target'],
] as const;

function Filters({
  filters,
  onApply,
}: {
  filters: AuditFilters;
  onApply: (next: AuditFilters) => void;
}) {
  const [draft, setDraft] = useState(filters);
  const set = (name: keyof AuditFilters, value: string) => setDraft({ ...draft, [name]: value });
  const apply = (event: FormEvent) => {
    event.preventDefault();
    onApply({ ...draft, view: filters.view });
  };
  return (
    <form className="org-audit-tools" onSubmit={apply}>
      {TEXT_FILTERS.map(([name, label]) => (
        <label key={name} className="source-field">
          {label}
          <input value={draft[name]} onChange={(e) => set(name, e.target.value)} />
        </label>
      ))}
      <label className="source-field">
        Outcome
        <select value={draft.outcome} onChange={(e) => set('outcome', e.target.value)}>
          <option value="">Any</option>
          {Object.entries(OUTCOMES).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
      </label>
      <label className="source-field">
        From
        <input type="date" value={draft.from} onChange={(e) => set('from', e.target.value)} />
      </label>
      <label className="source-field">
        To
        <input type="date" value={draft.to} onChange={(e) => set('to', e.target.value)} />
      </label>
      <button type="submit" className="quiet">
        Apply
      </button>
    </form>
  );
}

const VIEWS = [
  ['people', 'People'],
  ['system', 'System'],
] as const;

export function AdminAudit() {
  const [filters, setFilters] = useState(NO_FILTERS);
  const [detailed, setDetailed] = useState(false);
  return (
    <>
      {(detailed || filters !== NO_FILTERS) && (
        <>
          <fieldset className="admin-window">
            <legend className="sr-only">Whose actions</legend>
            {VIEWS.map(([id, label]) => (
              <button
                key={id}
                type="button"
                className="quiet"
                aria-pressed={filters.view === id}
                onClick={() => setFilters({ ...filters, view: id })}
              >
                {label}
              </button>
            ))}
          </fieldset>
          <Filters filters={filters} onApply={setFilters} />
        </>
      )}
      <Log key={JSON.stringify(filters)} filters={filters} onDetailed={setDetailed} />
    </>
  );
}
