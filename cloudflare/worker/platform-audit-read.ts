// Reading an organization's audit log: its filters, a page and the chain's walk. Whoever
// calls these has checked that the caller owns the org.
import { normalizeAccountIdentifier } from '../../shared/account';
import { auditCatchUp } from './account-audit';
import { ApiError } from './repo-ops';
import type { Env } from './types';
import { auditLog } from './workspace';

const KIND = /^[a-z_]+\.[a-z_]+$/;
const SEQ = /^[1-9][0-9]{0,15}$/;

/** The log's filters from a query, validated; an actor is an account, `user:` optional. */
export function auditFilters(query: URLSearchParams) {
  const before = query.get('before');
  const kind = query.get('kind');
  const actor = query.get('actor');
  if (before !== null && !SEQ.test(before))
    throw new ApiError('INVALID_INPUT', 'before must be a sequence number');
  if (kind !== null && !KIND.test(kind)) throw new ApiError('INVALID_INPUT', 'Unknown event kind');
  const account = actor === null ? null : normalizeAccountIdentifier(actor.replace(/^user:/, ''));
  if (actor !== null && !account) throw new ApiError('INVALID_INPUT', 'actor must be an account');
  return {
    ...(before !== null && { before: Number(before) }),
    ...(kind !== null && { kind }),
    ...(account && { actor: `user:${account}` }),
  };
}

/** `GET /orgs/:org/audit`. */
export async function auditPage(env: Env, org: string, query: URLSearchParams) {
  const raw = query.get('limit');
  if (raw !== null && !/^[1-9][0-9]{0,2}$/.test(raw))
    throw new ApiError('INVALID_INPUT', 'limit must be 1-200');
  const filters = auditFilters(query);
  await auditCatchUp(env, org);
  return auditLog(env, org, {
    op: 'audit_read',
    ...filters,
    ...(raw !== null && { limit: Number(raw) }),
  });
}

/** `GET /orgs/:org/audit/verify[?after=<seq>]`: one page of the chain's walk. */
export function auditVerify(env: Env, org: string, query: URLSearchParams) {
  const after = query.get('after');
  if (after !== null && !SEQ.test(after))
    throw new ApiError('INVALID_INPUT', 'after must be a sequence number');
  return auditLog(env, org, {
    op: 'audit_verify',
    ...(after !== null && { after: Number(after) }),
  });
}
