// A forgotten password by email, and a new recovery code (front Worker).
// - `password/forgot` answers before it looks at the account: the same words, status and timing
//   for a stranger, an unconfirmed address and a real asker. The caller's own limit is the only
//   refusal, and it never depends on the account. The platform does the rest.
// - `password/reset` is the reset page's POST. The link's token travels only in the URL's
//   fragment (platform-email-verify.ts), which no server, log or Referer header ever sees.
// - `recovery-code` is for a browser session: a token is refused even beside a cookie.
// Passwords and codes are handled by the account authority; here they pass through unlogged.

import { normalizeAccountIdentifier } from '../../shared/account';
import { auditMember } from './account-audit';
import { platformOf } from './account-email';
import { randomToken, sessionCookie } from './accounts';
import { afterAnswer } from './background';
import { accountFor } from './email-accounts';
import { error, readJson, response } from './http';
import { log } from './log';
import { sha } from './storage';
import type { Env } from './types';
import { workspace } from './workspace';

const LINK_INVALID = 'This link is invalid, used or expired. Ask for a new one.';
const unknownRoute = () => error('NOT_FOUND', 'Unknown authentication route', 404);

/** Whether this caller has spent its own limit (the same words on every route). */
async function callerLimited(req: Request, env: Env, route: string) {
  const address = req.headers.get('cf-connecting-ip') ?? 'local';
  return (
    env.AUTH_LIMITER && !(await env.AUTH_LIMITER.limit({ key: `${route}:${address}` })).success
  );
}
const tooMany = () => error('RATE_LIMITED', 'Wait before trying again', 429);

/** Asks the platform for a link. Never throws: nothing here may reach the answer. */
async function sendLink(env: Env, identifier: string) {
  try {
    await platformOf(env)?.passwordReset(await accountFor(env, identifier));
  } catch (e) {
    log.error('password.reset.request_failed', { error: e });
  }
}

async function forgot(req: Request, env: Env) {
  if (await callerLimited(req, env, 'forgot')) return tooMany();
  const { username } = await readJson(req);
  const identifier = typeof username === 'string' ? normalizeAccountIdentifier(username) : null;
  if (identifier) await afterAnswer(() => sendLink(env, identifier));
  return response({ requested: true });
}

async function reset(req: Request, env: Env) {
  if (await callerLimited(req, env, 'reset')) return tooMany();
  const { account: name, token, password } = await readJson(req);
  if (typeof password !== 'string' || password.length < 12 || password.length > 128)
    throw new Error('Use a password of 12–128 characters');
  const account = typeof name === 'string' ? normalizeAccountIdentifier(name) : null;
  if (!account || typeof token !== 'string' || !/^[0-9a-f]{64}$/.test(token))
    return error('INVALID_TOKEN', LINK_INVALID, 400);
  const recovery = randomToken();
  const result = await workspace(env, account, {
    op: 'password_reset',
    token_hash: await sha(token),
    password,
    salt: randomToken(16),
    new_recovery_hash: await sha(recovery),
  });
  if (result.suspended) return error('ACCOUNT_SUSPENDED', 'This account is suspended', 403);
  if (!result.authenticated) return error('INVALID_TOKEN', LINK_INVALID, 400);
  await auditMember(env, account);
  const answer = response({ recovery_code: recovery });
  answer.headers.set('set-cookie', sessionCookie(req));
  return answer;
}

async function regenerate(
  req: Request,
  env: Env,
  session: () => Promise<{ account: string; sessionHash: string } | null>,
) {
  const who = req.headers.has('authorization') ? null : await session();
  if (!who) return error('UNAUTHORIZED', 'Sign in to make a new recovery code', 401);
  const recovery = randomToken();
  const result = await workspace(env, who.account, {
    op: 'recovery_regenerate',
    session_hash: who.sessionHash,
    recovery_hash: await sha(recovery),
  });
  if (!result.regenerated)
    return error('NO_PASSWORD', 'This account has no password to recover', 409);
  await auditMember(env, who.account);
  return response({ recovery_code: recovery });
}

/** `/api/auth/<action>` for `password/forgot`, `password/reset` and `recovery-code`. */
export async function passwordRoute(
  req: Request,
  env: Env,
  action: string,
  session: () => Promise<{ account: string; sessionHash: string } | null>,
): Promise<Response> {
  if (req.method !== 'POST') return unknownRoute();
  if (action === 'password/forgot') return forgot(req, env);
  if (action === 'password/reset') return reset(req, env);
  if (action === 'recovery-code') return regenerate(req, env, session);
  return unknownRoute();
}
