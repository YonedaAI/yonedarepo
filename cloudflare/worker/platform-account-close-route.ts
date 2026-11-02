// `/api/v1/account/closure`: what the Delete account dialog reads, and the deletion. A person's
// session alone, recently signed in: a token can't, and neither can a laptop left open, and the
// proof works for an account with no password. `/admin/accounts/<a>/close` is the operators'.

import { normalizeAccountIdentifier } from '../../shared/account';
import { sessionCookie, signedInSession } from './accounts';
import { error, readJson, response } from './http';
import { closeAccount, closurePreview } from './platform-account-close';
import { failure } from './repo-api-failure';
import { ApiError, type Json } from './repo-ops';
import type { Env } from './types';

export const CLOSURE_PATH = '/api/v1/account/closure';
/** How recently a session must have signed in to delete its account. */
const FRESH_MS = 15 * 60_000;

const isFresh = (age: number | null) => age !== null && age <= FRESH_MS;

/** Whether `typed` names the account: its handle, or its name. */
const named = (typed: unknown, account: string, handle: unknown) => {
  const name = typeof typed === 'string' ? normalizeAccountIdentifier(typed) : null;
  return name !== null && (name === account || name === handle);
};

async function close(req: Request, env: Env, account: string, sessionHash: string) {
  const body = await readJson(req);
  const seen = await closurePreview(env, account, sessionHash);
  if (!named(body.confirm, account, seen.handle))
    throw new ApiError('INVALID_INPUT', 'Type your handle to confirm');
  if (!isFresh(seen.session_age_ms))
    throw new ApiError('SIGN_IN_AGAIN', 'Sign in again to delete this account');
  const done = await closeAccount(env, 'self', account);
  const answer = response(done);
  answer.headers.append('set-cookie', sessionCookie(req));
  return answer;
}

export async function closureApi(req: Request, env: Env): Promise<Response> {
  const origin = req.headers.get('origin');
  if (origin && origin !== new URL(req.url).origin)
    return error('UNAUTHORIZED', 'Same-origin request required', 401);
  try {
    const session = await signedInSession(req, env);
    if (!session) return error('UNAUTHORIZED', 'Sign in to delete your account', 401);
    if (req.method === 'GET') {
      const seen = await closurePreview(env, session.account, session.sessionHash);
      return response({ ...seen, fresh: isFresh(seen.session_age_ms) });
    }
    if (req.method === 'POST') return await close(req, env, session.account, session.sessionHash);
    return error('METHOD_NOT_ALLOWED', 'GET or POST only', 405);
  } catch (e) {
    return failure(e);
  }
}

/** `POST /admin/accounts/<a>/close {confirm?}`: says what it would do, and with the account's
 * name as `confirm` does it. The same refusals apply. */
export async function closeByOperator(env: Env, actor: string, account: string, body: Json) {
  if (body.confirm === undefined) return { dry_run: true, ...(await closurePreview(env, account)) };
  if (body.confirm !== account)
    throw new ApiError('INVALID_INPUT', "confirm must be the account's name");
  return closeAccount(env, actor, account);
}
