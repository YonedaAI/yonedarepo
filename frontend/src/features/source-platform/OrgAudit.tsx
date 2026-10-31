// An organization's audit log (`/orgs/:org/audit`): who did what, newest first, with filters
// and the exports. Owners only: the org page offers it to them and the server refuses
// everyone else whatever this page shows.
import { useState } from 'react';
import { PagedStatus, SearchBox, usePaged } from '../admin/AdminParts';
import {
  AUDIT_KINDS,
  type AuditFilters,
  type AuditRow,
  auditDetail,
  auditExportHref,
  auditLabel,
  auditPath,
  auditWho,
} from './orgAuditModel';
import { when } from './sourceApi';

function AuditTable({ org, filters }: { org: string; filters: AuditFilters }) {
  const paged = usePaged<AuditRow>((before) => auditPath(org, filters, before));
  const filtered = Boolean(filters.kind || filters.actor);
  return (
    <>
      {paged.items.length > 0 && (
        <div className="source-table-wrap">
          <table className="source-table admin-table">
            <caption className="sr-only">Audit log, newest first</caption>
            <thead>
              <tr>
                <th>When</th>
                <th>Who</th>
                <th>Event</th>
                <th>Details</th>
              </tr>
            </thead>
            <tbody>
              {paged.items.map((row) => (
                <tr key={row.seq}>
                  <td>{when(row.at)}</td>
                  <td>{auditWho(row)}</td>
                  <td>{auditLabel(row.kind)}</td>
                  <td className="admin-detail">{auditDetail(row)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <PagedStatus
        paged={paged}
        what="the audit log"
        empty={filtered ? 'No events match these filters.' : 'Nothing has been recorded yet.'}
      />
    </>
  );
}

export function OrgAudit({ org }: { org: string }) {
  const [kind, setKind] = useState('');
  const [actor, setActor] = useState('');
  const filters = { kind, actor };
  return (
    <section className="org-audit" aria-labelledby="org-audit-heading">
      <h2 id="org-audit-heading">Audit log</h2>
      <div className="org-audit-tools">
        <label htmlFor="org-audit-kind" className="source-field">
          Event
          <select id="org-audit-kind" value={kind} onChange={(e) => setKind(e.target.value)}>
            <option value="">All events</option>
            {Object.entries(AUDIT_KINDS).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <SearchBox label="Filter by account" value={actor} onSearch={setActor} />
        <p className="org-audit-exports">
          Export <a href={auditExportHref(org, 'csv', filters)}>CSV</a>{' '}
          <a href={auditExportHref(org, 'json', filters)}>JSON</a>
        </p>
      </div>
      <AuditTable key={`${kind}:${actor}`} org={org} filters={filters} />
    </section>
  );
}
