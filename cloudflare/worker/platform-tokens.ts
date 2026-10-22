// Account token routes of the platform API: `/api/v1/tokens` (personal access tokens) and
// device login (`/api/v1/device/*`, RFC 8628 shape). A token is issued only to a person
// signed in to their account (session cookie), directly or by approving a device code;
// the device then redeems its code once for the token. Codes live in their own authority
// instance (`device:<user code>`) for ten minutes and hold no token, only grants.
import { ApiError, type Credentials, type Json } from './repo-ops';
import { base64url, issuePat, requirePatScope, revokePat, sha } from './repo-pat';
import type { Env } from './types';
import { workspace } from './workspace';

const ALPHABET = 'BCDFGHJKLMNPQRSTVWXZ';
const USER_CODE = /^[BCDFGHJKLMNPQRSTVWXZ]{8}$/;
const DEVICE_CODE = /^([BCDFGHJKLMNPQRSTVWXZ]{8})\.([A-Za-z0-9_-]{43})$/;
const LIFETIME_SECONDS = 600;

/** The device authority for one user code (shares the workspace class and schema). */
async function device(env: Env, code: string, command: Json): Promise<Json> {
  const response = await env.WORKSPACES.get(env.WORKSPACES.idFromName(`device:${code}`)).fetch(
    'http://workspace/command',
    { method: 'POST', body: JSON.stringify({ ...command, user_code: code }) },
  );
  const value = await response.json<Json>();
  if (!response.ok) throw new ApiError(value.error?.code ?? 'DEVICE_FAILED', value.error?.message);
  return value;
}

/** A person signed in to their own account: the only caller that may grant tokens. */
function person(auth: Credentials): string {
  if ('_session' in auth && auth._session.human) return auth._session.workspace;
  throw new ApiError('UNAUTHORIZED', 'Sign in to your account to grant tokens');
}

/** The account whose tokens `auth` manages: its person, or its repo:admin token. */
function manager(auth: Credentials): string {
  if ('_pat' in auth) {
    requirePatScope(auth, 'repo:admin');
    return auth._pat.workspace;
  }
  return person(auth);
}

async function limited(req: Request, env: Env) {
  const key = `device:${req.headers.get('cf-connecting-ip') ?? 'local'}`;
  if (env.AUTH_LIMITER && !(await env.AUTH_LIMITER.limit({ key })).success)
    throw new ApiError('RATE_LIMITED', 'Wait before trying again');
}

/** `/api/v1/tokens[/:id]` for an authenticated caller. */
export async function tokenRoute(
  env: Env,
  auth: Credentials,
  method: string,
  id: string | undefined,
  body: () => Promise<Json>,
): Promise<Json> {
  if (!id && method === 'GET') {
    const listed = await workspace(env, manager(auth), { op: 'pat_list' });
    return { tokens: listed.tokens };
  }
  if (!id && method === 'POST') return issuePat(env, person(auth), await body());
  if (id && method === 'DELETE') return revokePat(env, manager(auth), id);
  throw new ApiError('NOT_FOUND', 'Unknown API path');
}

function newUserCode() {
  const out: string[] = [];
  while (out.length < 8) {
    for (const byte of crypto.getRandomValues(new Uint8Array(16))) {
      // 240 = 12 * 20: unbiased choice from the alphabet.
      if (byte < 240 && out.length < 8) out.push(ALPHABET[byte % 20]);
    }
  }
  return out.join('');
}

/** `POST /api/v1/device/code`: a new code pair for a device (no credentials). */
export async function deviceCode(req: Request, env: Env, body: Json, url: URL) {
  await limited(req, env);
  const client = typeof body.client_name === 'string' ? body.client_name : '';
  for (let attempt = 0; ; attempt++) {
    const code = newUserCode();
    const secret = base64url(crypto.getRandomValues(new Uint8Array(32)));
    try {
      const created = await device(env, code, {
        op: 'device_create',
        secret_hash: await sha(secret),
        client_name: client,
      });
      const shown = `${code.slice(0, 4)}-${code.slice(4)}`;
      const site = (env.WEB_ORIGIN || url.origin).replace(/\/$/, '');
      return {
        device_code: `${code}.${secret}`,
        user_code: shown,
        verification_uri: `${site}/device`,
        verification_uri_complete: `${site}/device?code=${shown}`,
        expires_in: LIFETIME_SECONDS,
        interval: created.interval,
      };
    } catch (e) {
      if (!(e instanceof ApiError && e.code === 'ALREADY_EXISTS') || attempt >= 3) throw e;
    }
  }
}

/** `POST /api/v1/device/approve`: the signed-in person grants (or denies) a device. */
export async function deviceApprove(env: Env, auth: Credentials, body: Json) {
  const account = person(auth);
  const code = String(body.user_code ?? '')
    .toUpperCase()
    .replace(/-/g, '');
  if (!USER_CODE.test(code)) throw new ApiError('INVALID_INPUT', 'Unknown code format');
  const approved = await device(env, code, {
    op: 'device_approve',
    account,
    scopes: body.scopes,
    repos: body.repos ?? null,
    expires_days: body.expires_days ?? 30,
    deny: body.deny === true,
  });
  return { approved: approved.approved === true };
}

/** `POST /api/v1/device/token`: the device redeems its approved code, once. */
export async function deviceToken(req: Request, env: Env, body: Json) {
  await limited(req, env);
  const parts = DEVICE_CODE.exec(String(body.device_code ?? ''));
  if (!parts) throw new ApiError('EXPIRED_TOKEN', 'Unknown or expired device code');
  const polled = await device(env, parts[1], {
    op: 'device_poll',
    secret_hash: await sha(parts[2]),
  });
  if (polled.status !== 'APPROVED') {
    const messages: Json = {
      AUTHORIZATION_PENDING: 'Waiting for approval in the browser',
      SLOW_DOWN: `Poll at most every ${polled.interval} seconds`,
      ACCESS_DENIED: 'The request was denied',
      EXPIRED_TOKEN: 'Unknown, used or expired device code',
    };
    const code = messages[polled.status] ? polled.status : 'EXPIRED_TOKEN';
    throw new ApiError(
      code,
      messages[code],
      polled.interval ? { interval: polled.interval } : undefined,
    );
  }
  const grant = polled.grant;
  const issued = await issuePat(env, polled.account, {
    name: polled.client_name,
    scopes: grant.scopes,
    repos: grant.repos,
    expires_days: grant.expires_days,
  });
  return {
    token: issued.token,
    scopes: issued.scopes,
    repos: issued.repos,
    expires_at: issued.expires_at,
    account: polled.account,
  };
}
