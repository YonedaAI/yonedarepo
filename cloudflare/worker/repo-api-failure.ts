// How a failure answers on the REST API: its code's status, and for what the platform did not plan,
// the one line a forced 500 must leave.
import { failureCode, RETRY_AFTER_SECONDS } from './durable';
import { error, response } from './http';
import { logFailure } from './log';
import { ApiError, type Json } from './repo-ops';

const STATUS: Record<string, number> = {
  NOT_FOUND: 404,
  FORBIDDEN: 403,
  UNAUTHORIZED: 401,
  CONFLICT: 409,
  ACTIVITY_CHANGED: 409,
  MERGE_REQUIRED: 409,
  STALE_PARENT: 409,
  NOT_READY: 409,
  STALE_HEAD: 409,
  STALE_EPOCH: 409,
  NOT_LANDED: 409,
  AUTOMATION_PAUSED: 423,
  // Under a legal hold (repo_store/legal_hold.rs), or one that could not be read.
  LEGAL_HOLD: 423,
  ALREADY_EXISTS: 409,
  NAME_TAKEN: 409,
  PUSH_FAILED: 502,
  NOT_SUPPORTED: 400,
  TIMEOUT: 503,
  STALE_HANDLE: 409,
  PARSE_FAILED: 422,
  SECRET_DETECTED: 422,
  GONE: 404,
  RATE_LIMITED: 429,
  OVERLOADED: 503,
  // A create that failed and took back what it did: the same request can be repeated.
  CREATE_UNAVAILABLE: 503,
  // Contact support: no address to reply to, email not set up here, or the send failed.
  NO_EMAIL: 409,
  SUPPORT_UNAVAILABLE: 503,
  SUPPORT_SEND_FAILED: 503,
  INTERNAL: 500,
  // The account keeps as many favorites as it may (platform-favorites.ts).
  FAVORITES_FULL: 409,
  // An operator suspended the account (platform-admin.ts): its credentials are refused.
  ACCOUNT_SUSPENDED: 403,
  // Withheld by the repository's owner (quarantine): known, deliberately not served.
  QUARANTINED: 451,
  // The repository's database is at its limit: new work is refused, reads go on.
  REPO_FULL: 507,
  // The repository's Git objects reached the published size: no more pushes or new commits.
  REPO_SIZE_LIMIT: 507,
  // Operators' billing: no refund key or no way to the managed Worker, and a refund a
  // configured limit refuses, or one blocked by an open dispute.
  NOT_CONFIGURED: 503,
  REFUND_LIMIT: 403,
  DISPUTED: 409,
};
export const statusOf = (code: string, known: boolean) => STATUS[code] ?? (known ? 400 : 500);

/** A JSON answer, or the API error a failure maps to. */
export const answer = (run: () => Promise<Json>) => run().then(response, failure);

/** 5xx answers the platform means to give: load, a limit, or a service it says is not set up.
 * Each is a state of the system, counted by status; none is a fault to investigate. */
const PLANNED = new Set([
  'OVERLOADED',
  'CREATE_UNAVAILABLE',
  'REPO_FULL',
  'REPO_SIZE_LIMIT',
  'NOT_CONFIGURED',
  'SUPPORT_UNAVAILABLE',
  'SUPPORT_SEND_FAILED',
]);

/** The API error a failure maps to: an overloaded or unreachable Durable Object is 503
 * OVERLOADED with Retry-After (clients retry it), anything unexpected 500 INTERNAL. A failed
 * statement in the authority answers 400 for now, but is no fault of the caller's. */
export function failure(e: any): Response {
  const code = failureCode(e);
  const message = String(e?.message ?? e).slice(0, 500);
  const status = statusOf(code, e instanceof ApiError || typeof e?.code === 'string');
  if ((status >= 500 && !PLANNED.has(code)) || code === 'DATABASE') logFailure(e, code, status);
  const refused =
    e instanceof ApiError && e.details
      ? response({ error: { code, message, details: e.details } }, status)
      : error(code, message, status);
  if (code === 'OVERLOADED' || code === 'CREATE_UNAVAILABLE')
    refused.headers.set('retry-after', String(RETRY_AFTER_SECONDS));
  return refused;
}
