// Account token routes of the platform API: `/api/v1/tokens` (personal access tokens) and
// device login (`/api/v1/device/*`, RFC 8628 shape). A token is issued only to a person
// signed in to their account (session cookie), directly or by approving a device code;
// the device then redeems its code once for the token. Codes live in their own authority
// instance (`device:<user code>`) for ten minutes and hold no token, only grants. With
// AGENT_SIGNUP on, a code can ask for an agent: `yoneda login --agent <name>`.
import { auditDevice } from './account-audit';
import { releaseClaims } from './platform-ssh-keys';
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

const agentsOn = (env: Env) => env.AGENT_SIGNUP === 'on';

/** A user code as typed (`BCDF-GHJK`) in the form its authority is named by. */
function userCode(typed: unknown) {
  const code = String(typed ?? '')
    .toUpperCase()
    .replace(/-/g, '');
  if (!USER_CODE.test(code)) throw new ApiError('INVALID_INPUT', 'Unknown code format');
  return code;
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
  if (id && method === 'DELETE') {
    const account = manager(auth);
    const revoked = await revokePat(env, account, id);
    await releaseClaims(env, account, revoked.removed_ssh_keys);
    return revoked;
  }
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
  // The CLI's machine name labels the token it receives (the authority validates it).
  const host = body.host ?? null;
  const agent = body.agent ?? null;
  if (agent !== null && !agentsOn(env)) throw new ApiError('NOT_SUPPORTED', 'Agent sign-up is off');
  for (let attempt = 0; ; attempt++) {
    const code = newUserCode();
    const secret = base64url(crypto.getRandomValues(new Uint8Array(32)));
    try {
      const created = await device(env, code, {
        op: 'device_create',
        secret_hash: await sha(secret),
        client_name: client,
        host,
        agent,
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

/** `GET /api/v1/device/pending?code=`: who is asking, for the page approving a code. */
async function devicePending(env: Env, auth: Credentials, url: URL) {
  person(auth);
  const code = userCode(url.searchParams.get('code'));
  if (!agentsOn(env)) return { agent: null, host: null };
  const { agent, host } = await device(env, code, { op: 'device_show' });
  return { agent: agent ?? null, host: host ?? null };
}

/** `POST /api/v1/device/approve`: the signed-in person grants (or denies) a device. */
async function deviceApprove(env: Env, auth: Credentials, body: Json) {
  const account = person(auth);
  const code = userCode(body.user_code);
  const deny = body.deny === true;
  if (agentsOn(env) && !deny) {
    // Asked here too, so that a full account refuses before the code is spent on it.
    const { agent } = await device(env, code, { op: 'device_show' });
    if (agent) await workspace(env, account, { op: 'pat_agent_room', name: agent });
  }
  const approved = await device(env, code, {
    op: 'device_approve',
    account,
    scopes: body.scopes,
    repos: body.repos ?? null,
    all_repos: body.all_repos === true,
    org: body.org ?? null,
    expires_days: body.expires_days ?? 30,
    deny,
    agent_signup: agentsOn(env),
  });
  await auditDevice(env, account, approved);
  return { approved: approved.approved === true };
}

/** `/api/v1/device/*` for a signed-in caller. */
export async function deviceRoute(
  env: Env,
  auth: Credentials,
  action: string,
  req: Request,
  url: URL,
  body: () => Promise<Json>,
): Promise<Json> {
  if (action === 'approve' && req.method === 'POST') return deviceApprove(env, auth, await body());
  if (action === 'pending' && req.method === 'GET') return devicePending(env, auth, url);
  throw new ApiError('NOT_FOUND', 'Unknown API path');
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
  const agent: string | null = polled.agent ?? null;
  const issued = await issuePat(
    env,
    polled.account,
    {
      name: agent ?? polled.client_name,
      scopes: grant.scopes,
      repos: grant.repos,
      org: grant.org ?? null,
      expires_days: grant.expires_days,
    },
    { origin: agent ? `agent:${agent}` : 'login', host: polled.host ?? null },
  );
  return {
    token: issued.token,
    scopes: issued.scopes,
    repos: issued.repos,
    expires_at: issued.expires_at,
    account: polled.account,
    agent,
  };
}
