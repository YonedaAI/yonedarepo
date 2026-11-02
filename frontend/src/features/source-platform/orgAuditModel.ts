// An organization's audit log as the API reports it (`GET /orgs/:org/audit`), its paths and
// the words the page shows. The server decides who reads it and what a row holds.

export type AuditRow = {
  seq: number;
  kind: string;
  /** `user:<account>`; null on an event from before actors were recorded. */
  actor: string | null;
  at: number;
  source: string;
  source_seq: number;
  details: Record<string, unknown>;
  previous: string;
  hash: string;
};
export type AuditFilters = { kind: string; actor: string };

export const AUDIT_KINDS: Record<string, string> = {
  'org.created': 'Organization created',
  'org.deleted': 'Organization deleted',
  'org.member_put': 'Member added or changed',
  'org.member_removed': 'Member removed',
  'org.team_created': 'Team created',
  'org.team_deleted': 'Team deleted',
  'org.team_member_added': 'Added to team',
  'org.team_member_removed': 'Removed from team',
  'pat.created': 'Token created',
  'pat.revoked': 'Token revoked',
  'ssh_key.added': 'SSH key added',
  'ssh_key.removed': 'SSH key removed',
  'account.recovered': 'Account recovered',
  'account.password_reset': 'Password reset by email',
  'account.recovery_regenerated': 'Recovery code regenerated',
  'audit.exported': 'Audit log exported',
  'audit.row_set_aside': 'Unreadable audit event set aside',
  'repo.created': 'Repository created',
  'repo.deleted': 'Repository deleted',
  'repo.restored': 'Repository restored',
  'repo.purge_requested': 'Repository permanently deleted',
  'repo.renamed': 'Repository renamed',
  'repo.visibility_changed': 'Repository visibility changed',
  'repo.member_put': 'Repository member added or changed',
  'repo.member_removed': 'Repository member removed',
  'repo.token_created': 'Repository token created',
  'repo.token_revoked': 'Repository token revoked',
  'repo.policy_changed': 'Landing rules changed',
  'repo.retention_changed': 'Retention changed',
  'repo.break_glass': 'Break glass used',
  'webhook.created': 'Webhook created',
  'webhook.deleted': 'Webhook deleted',
  'webhook.disabled': 'Webhook switched off after failures',
  'legal_hold.set': 'Legal hold set',
  'legal_hold.released': 'Legal hold released',
};

const search = (filters: AuditFilters, more: [string, string][] = []) => {
  const query = new URLSearchParams(more);
  if (filters.kind) query.set('kind', filters.kind);
  if (filters.actor) query.set('actor', filters.actor);
  return query;
};

/** The page of the log before `before` (newest first), filtered. */
export function auditPath(org: string, filters: AuditFilters, before?: number) {
  const query = search(filters);
  if (before !== undefined) query.set('before', String(before));
  const text = query.toString();
  return `/orgs/${org}/audit${text ? `?${text}` : ''}`;
}

/** The whole log as a file, filtered; a link, since the browser saves it. */
export const auditExportHref = (org: string, format: 'csv' | 'json', filters: AuditFilters) =>
  `/api/v1/orgs/${org}/audit/export?${search(filters, [['format', format]])}`;

export const auditWho = (row: AuditRow) => row.actor?.replace(/^user:/, '') ?? 'Not recorded';
export const auditLabel = (kind: string) => AUDIT_KINDS[kind] ?? kind;

export const auditDetail = (row: AuditRow) =>
  Object.entries(row.details)
    .map(([key, value]) => `${key}: ${Array.isArray(value) ? value.join(', ') : value}`)
    .join(' · ');
