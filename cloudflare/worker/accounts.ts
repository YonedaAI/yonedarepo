import {
  ACCOUNT_IDENTIFIER_HELP,
  decodeAccountIdentifier,
  encodeAccountIdentifier,
  normalizeAccountIdentifier,
} from '../../shared/account';
import { auditMember } from './account-audit';
import { accountCreated, emailRoute } from './account-email';
import { handleState, setHandle } from './account-handles';
import { noteSeen } from './account-index';
import { notificationsRoute } from './account-notifications';
import { passwordRoute } from './account-password';
import { noteHome } from './account-place';
import { isAdminAccount } from './admin-auth';
import { avatarInfo, ownAvatarUrl } from './avatars';
import { HOME_COOKIE } from './cell-names';
import { cellOfRegion, cellsOn, thisCell } from './cells';
import { accountFor, signUpWithEmail, signupEmail } from './email-accounts';
import { error, readJson, response } from './http';
import { unlink } from './oauth-identity';
import { configuredProviders } from './oauth-providers';
import { signupRegion } from './region';
import { readSignupSource, recordSignup } from './site-events';
import { withSource } from './site-visitors';
import { sha } from './storage';
import type { Env, Json, Principal } from './types';
import { workspace } from './workspace';

const cookieName = 'yoneda_account';
export function randomToken(bytes = 32) {
  return [...crypto.getRandomValues(new Uint8Array(bytes))]
    .map((v) => v.toString(16).padStart(2, '0'))
    .join('');
}
export function username(value: unknown) {
  if (typeof value !== 'string') throw new Error('Username or email required');
  const name = normalizeAccountIdentifier(value);
  if (!name) throw new Error(ACCOUNT_IDENTIFIER_HELP);
  return name;
}
export function sessionCookie(req: Request, value = '') {
  return `${cookieName}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${value ? 604800 : 0}${new URL(req.url).protocol === 'https:' ? '; Secure' : ''}`;
}
/** Which cell this browser's account-wide requests start at (cell-edge.ts). Routing only: it
 * grants nothing, and a forged one reaches a cell that answers the same. */
export function homeCookie(req: Request, cell: string) {
  return `${HOME_COOKIE}=${cell}; Path=/; HttpOnly; SameSite=Strict; Max-Age=604800${new URL(req.url).protocol === 'https:' ? '; Secure' : ''}`;
}
function sessionValue(req: Request) {
  const raw = req.headers
    .get('cookie')
    ?.split(';')
    .map((v) => v.trim())
    .find((v) => v.startsWith(`${cookieName}=`))
    ?.slice(cookieName.length + 1);
  if (!raw) return null;
  const parts = raw.split('.');
  if (parts.length !== 2 || !/^[a-f0-9]{64}$/.test(parts[1])) return null;
  const name = decodeAccountIdentifier(parts[0]);
  if (!name) return null;
  const token = parts[1];
  return { name, token };
}
/** The account a session cookie names, unchecked: enough to leave a point out of the figures,
 * which is all a forged name can do. */
export const sessionAccount = (req: Request) => sessionValue(req)?.name ?? null;
/** The signed-in account and its session's digest (linking a provider records both). */
export async function signedInSession(req: Request, env: Env) {
  const session = sessionValue(req);
  if (!session) return null;
  const sessionHash = await sha(session.token);
  const result = await workspace(env, session.name, { op: 'session', session_hash: sessionHash });
  return result.authenticated ? { account: session.name, sessionHash } : null;
}
/** The session's account, or why there is none (`suspended` by an operator). A signed-in
 * check notes the account as seen today (platform-accounts). */
async function sessionCheck(req: Request, env: Env) {
  const session = sessionValue(req);
  if (!session) return { principal: null, suspended: false };
  const result = await workspace(env, session.name, {
    op: 'session',
    session_hash: await sha(session.token),
  });
  if (!result.authenticated) return { principal: null, suspended: result.suspended === true };
  noteHome(env, result);
  // Its row is in its home cell; another cell has no row to touch and must not make one.
  if (cellOfRegion(env, result.region) === thisCell(env)) noteSeen(env, session.name);
  const principal: Principal = { workspace: session.name, role: 'user', orgs: result.orgs ?? [] };
  return { principal, suspended: false };
}
export async function accountPrincipal(req: Request, env: Env): Promise<Principal | null> {
  return (await sessionCheck(req, env)).principal;
}
export async function accountRoute(req: Request, env: Env): Promise<Response | null> {
  const path = new URL(req.url).pathname;
  if (!path.startsWith('/api/auth/')) return null;
  if (req.headers.has('origin') && req.headers.get('origin') !== new URL(req.url).origin)
    return error('UNAUTHORIZED', 'Same-origin request required', 401);
  const action = path.slice('/api/auth/'.length);
  try {
    if (action === 'notifications' || action.startsWith('notifications/'))
      return notificationsRoute(req, env, async () => {
        const session = await signedInSession(req, env);
        return session ? { workspace: session.account, sessionHash: session.sessionHash } : null;
      });
    let result: Response;
    if (action === 'session' && req.method === 'GET') {
      const { principal, suspended } = await sessionCheck(req, env);
      const identity = principal
        ? {
            authenticated: true,
            username: principal.workspace,
            is_admin: isAdminAccount(env, principal.workspace),
          }
        : { authenticated: false, ...(suspended ? { suspended: true } : {}) };
      if (!principal || new URL(req.url).searchParams.get('summary') === 'true') {
        result = response(identity);
      } else {
        const [avatar, handle] = await Promise.all([
          avatarInfo(env, principal.workspace).catch(() => null),
          handleState(env, principal.workspace),
        ]);
        result = response({
          ...identity,
          ...handle,
          avatar_url: ownAvatarUrl(avatar),
          avatar_source: avatar?.source ?? null,
        });
      }
    } else if (action === 'handle' && req.method === 'PUT') {
      const principal = await accountPrincipal(req, env);
      if (!principal) return error('UNAUTHORIZED', 'Sign in to choose a handle', 401);
      try {
        result = response(await setHandle(env, principal.workspace, (await readJson(req)).handle));
      } catch (e: any) {
        const status = ['HANDLE_TAKEN', 'HANDLE_FIXED'].includes(e?.code) ? 409 : 400;
        return error(e?.code ?? 'INVALID_INPUT', e?.message ?? 'Handle refused', status);
      }
    } else if (action === 'name' && req.method === 'PUT') {
      const principal = await accountPrincipal(req, env);
      if (!principal) return error('UNAUTHORIZED', 'Sign in to set your name', 401);
      const { name } = await readJson(req);
      result = response(await workspace(env, principal.workspace, { op: 'name_set', name }));
    } else if (action === 'providers' && req.method === 'GET') {
      // Sign-in providers whose secrets are set (the sign-in page shows only these).
      result = response({ providers: configuredProviders(env) });
    } else if ((action === 'identities' && req.method === 'GET') || action === 'unlink') {
      const principal = await accountPrincipal(req, env);
      if (!principal) return error('UNAUTHORIZED', 'Sign in to manage sign-in methods', 401);
      if (req.method === 'GET')
        result = response({
          ...(await workspace(env, principal.workspace, { op: 'identity_list' })),
          providers: configuredProviders(env),
        });
      else if (req.method === 'POST')
        result = response(
          await unlink(env, principal.workspace, String((await readJson(req)).provider ?? '')),
        );
      else return error('NOT_FOUND', 'Unknown authentication route', 404);
    } else if (action === 'email' || action.startsWith('email/')) {
      result = await emailRoute(req, env, action, () => accountPrincipal(req, env));
    } else if (action.startsWith('password/') || action === 'recovery-code') {
      result = await passwordRoute(req, env, action, () => signedInSession(req, env));
    } else if (action === 'logout' && req.method === 'POST') {
      const session = sessionValue(req);
      if (session)
        await workspace(env, session.name, {
          op: 'logout',
          session_hash: await sha(session.token),
        });
      result = response({ authenticated: false });
      result.headers.set('set-cookie', sessionCookie(req));
    } else if (['signup', 'login', 'recover'].includes(action) && req.method === 'POST') {
      if (
        env.AUTH_LIMITER &&
        !(await env.AUTH_LIMITER.limit({ key: req.headers.get('cf-connecting-ip') ?? 'local' }))
          .success
      )
        return error('RATE_LIMITED', 'Wait before trying again', 429);
      const body = await readJson(req);
      // A new account signs up with an email address only; sign-in takes a name or an address.
      const email = action === 'signup' ? signupEmail(body) : null;
      if (
        typeof body.password !== 'string' ||
        body.password.length > 128 ||
        (action !== 'login' && body.password.length < 12)
      )
        throw new Error('Use a password of 12–128 characters');
      const token = randomToken();
      const recovery = randomToken();
      let name: string;
      let account: Json;
      if (email) {
        account = await signUpWithEmail(env, email, {
          op: 'signup',
          password: body.password,
          salt: randomToken(16),
          session_hash: await sha(token),
          recovery_hash: await sha(recovery),
          ...signupRegion(req, env),
        });
        name = String(account.username);
      } else {
        name = await accountFor(env, username(body.username));
        account = await workspace(
          env,
          name,
          action === 'login'
            ? {
                op: action,
                password: body.password,
                session_hash: await sha(token),
                ...(cellsOn(env) && { place: true }),
              }
            : {
                op: action,
                password: body.password,
                salt: randomToken(16),
                recovery_hash: await sha(String(body.recovery_code ?? '')),
                new_recovery_hash: await sha(recovery),
              },
        );
      }
      if (account.suspended) return error('ACCOUNT_SUSPENDED', 'This account is suspended', 403);
      if (!account.authenticated)
        return error(
          'UNAUTHORIZED',
          'Credentials did not match; wait a minute after repeated attempts',
          401,
        );
      if (action === 'recover') await auditMember(env, name);
      if (action === 'signup') {
        const source = readSignupSource(body.source);
        const region = signupRegion(req, env);
        await accountCreated(env, name, email, 'email', withSource(env, region, source));
        recordSignup(env, req, 'email', source);
      }
      // The region reaches the routing cookie, not the answer, which is what it always was.
      const { region: home, cells: _cells, ...publicAccount } = account;
      result = response({
        ...publicAccount,
        ...(action !== 'login' ? { recovery_code: recovery } : {}),
      });
      if (action !== 'recover') {
        result.headers.set(
          'set-cookie',
          sessionCookie(req, `${encodeAccountIdentifier(name)}.${token}`),
        );
        if (cellsOn(env)) {
          const region = action === 'signup' ? signupRegion(req, env).region : home;
          result.headers.append('set-cookie', homeCookie(req, cellOfRegion(env, region)));
        }
      } else result.headers.set('set-cookie', sessionCookie(req));
    } else return error('NOT_FOUND', 'Unknown authentication route', 404);
    result.headers.set('cache-control', 'no-store');
    return result;
  } catch (e: any) {
    return error(e.code ?? 'INVALID_INPUT', e.message ?? 'Authentication failed', 400);
  }
}
