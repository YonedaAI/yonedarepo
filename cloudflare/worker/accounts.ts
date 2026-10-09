import { error, readJson, response } from './http';
import { sha } from './storage';
import type { Env, Principal } from './types';
import { workspace } from './workspace';

const cookieName = 'yoneda_account';
export function randomToken(bytes = 32) {
  return [...crypto.getRandomValues(new Uint8Array(bytes))]
    .map((v) => v.toString(16).padStart(2, '0'))
    .join('');
}
export function username(value: unknown) {
  if (typeof value !== 'string') throw new Error('Username required');
  const name = value.trim().toLowerCase();
  if (!/^[a-z][a-z0-9_]{2,31}$/.test(name))
    throw new Error('Use 3–32 letters, digits or underscores, starting with a letter');
  return name;
}
function cookie(req: Request, value = '') {
  return `${cookieName}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${value ? 604800 : 0}${new URL(req.url).protocol === 'https:' ? '; Secure' : ''}`;
}
function sessionValue(req: Request) {
  const raw = req.headers
    .get('cookie')
    ?.split(';')
    .map((v) => v.trim())
    .find((v) => v.startsWith(`${cookieName}=`))
    ?.slice(cookieName.length + 1);
  if (!raw || !/^[a-z][a-z0-9_]{2,31}\.[a-f0-9]{64}$/.test(raw)) return null;
  const [name, token] = raw.split('.');
  return { name, token };
}
export async function accountPrincipal(req: Request, env: Env): Promise<Principal | null> {
  const session = sessionValue(req);
  if (!session) return null;
  const result = await workspace(env, session.name, {
    op: 'session',
    session_hash: await sha(session.token),
  });
  return result.authenticated ? { workspace: session.name, role: 'user' } : null;
}
export async function accountRoute(req: Request, env: Env): Promise<Response | null> {
  const path = new URL(req.url).pathname;
  if (!path.startsWith('/api/auth/')) return null;
  if (req.headers.has('origin') && req.headers.get('origin') !== new URL(req.url).origin)
    return error('UNAUTHORIZED', 'Same-origin request required', 401);
  const action = path.slice('/api/auth/'.length);
  try {
    let result: Response;
    if (action === 'session' && req.method === 'GET') {
      const principal = await accountPrincipal(req, env);
      result = response(
        principal
          ? { authenticated: true, username: principal.workspace }
          : { authenticated: false },
      );
    } else if (action === 'logout' && req.method === 'POST') {
      const session = sessionValue(req);
      if (session)
        await workspace(env, session.name, {
          op: 'logout',
          session_hash: await sha(session.token),
        });
      result = response({ authenticated: false });
      result.headers.set('set-cookie', cookie(req));
    } else if (['signup', 'login', 'recover'].includes(action) && req.method === 'POST') {
      if (
        env.AUTH_LIMITER &&
        !(await env.AUTH_LIMITER.limit({ key: req.headers.get('cf-connecting-ip') ?? 'local' }))
          .success
      )
        return error('RATE_LIMITED', 'Wait before trying again', 429);
      const body = await readJson(req);
      const name = username(body.username);
      if (
        typeof body.password !== 'string' ||
        body.password.length > 128 ||
        (action !== 'login' && body.password.length < 12)
      )
        throw new Error('Use a password of 12–128 characters');
      const token = randomToken();
      const recovery = randomToken();
      const command =
        action === 'signup'
          ? {
              op: action,
              username: name,
              password: body.password,
              salt: randomToken(16),
              session_hash: await sha(token),
              recovery_hash: await sha(recovery),
            }
          : action === 'login'
            ? { op: action, password: body.password, session_hash: await sha(token) }
            : {
                op: action,
                password: body.password,
                salt: randomToken(16),
                recovery_hash: await sha(String(body.recovery_code ?? '')),
                new_recovery_hash: await sha(recovery),
              };
      const account = await workspace(env, name, command);
      if (!account.authenticated)
        return error(
          'UNAUTHORIZED',
          'Credentials did not match; wait a minute after repeated attempts',
          401,
        );
      result = response({ ...account, ...(action !== 'login' ? { recovery_code: recovery } : {}) });
      if (action !== 'recover') result.headers.set('set-cookie', cookie(req, `${name}.${token}`));
      else result.headers.set('set-cookie', cookie(req));
    } else return error('NOT_FOUND', 'Unknown authentication route', 404);
    result.headers.set('cache-control', 'no-store');
    return result;
  } catch (e: any) {
    return error(e.code ?? 'INVALID_INPUT', e.message ?? 'Authentication failed', 400);
  }
}
