// The platform side of Git over SSH. The SSH gateway (backend/crates/yoneda-ssh-gateway,
// in the SshGateway container) verifies a client's key signature, then asks here:
//   POST /internal/ssh/lookup  {fingerprint}                         -> {account, key_id}
//   POST /internal/ssh/session {account, key_id, fingerprint, repo, service} -> {token}
// Both carry an HS256 JWT signed with SSH_GATEWAY_SECRET (issuer yoneda-ssh-gateway,
// audience yoneda-platform, at most two minutes old). The session token (`ysh_…`, ten
// minutes) is the gateway's bearer on this Worker's smart-HTTP endpoints for exactly one
// repository and service; every request re-checks the key with its account, so a removed
// key stops the next request of an open session. The token is signed, not stored.
import { jwtVerify } from 'jose';
import { error, response } from './http';
import { orgAccess } from './platform-org-access';
import { checkKey, lookupKey } from './platform-ssh-keys';
import type { PatGrant, PatScope } from './repo-pat';
import { base64url } from './repo-pat';
import { fromBase64 } from './repo-stores';
import type { Env, Json } from './types';

const TOKEN_TTL_MS = 10 * 60 * 1000;
const TOKEN = /^ysh_([A-Za-z0-9_-]{1,1024})\.([A-Za-z0-9_-]{43})$/;
const REPO = /^r[0-9a-f]{20}$/;
const FINGERPRINT = /^SHA256:[A-Za-z0-9+/]{43}$/;
const KEY_ID = /^ssh_[0-9a-f]{16}$/;
const SCOPES: Record<string, PatScope[]> = {
  'git-upload-pack': ['repo:read'],
  'git-receive-pack': ['repo:read', 'repo:write', 'repo:land'],
};
const enc = new TextEncoder();

/** The gateway secret, or null where SSH is not configured (too short counts as unset). */
const secretOf = (env: Env) =>
  env.SSH_GATEWAY_SECRET && env.SSH_GATEWAY_SECRET.length >= 32 ? env.SSH_GATEWAY_SECRET : null;

let keyCache: { secret: string; key: Promise<CryptoKey> } | undefined;
/** The session-token MAC key: HMAC(secret, label), so a token never verifies as a JWT. */
function tokenKey(secret: string) {
  if (keyCache?.secret !== secret) {
    const key = (async () => {
      const master = await crypto.subtle.importKey(
        'raw',
        enc.encode(secret),
        { name: 'HMAC', hash: 'SHA-256' },
        false,
        ['sign'],
      );
      const derived = await crypto.subtle.sign('HMAC', master, enc.encode('ysh-session-token-v1'));
      return crypto.subtle.importKey('raw', derived, { name: 'HMAC', hash: 'SHA-256' }, false, [
        'sign',
        'verify',
      ]);
    })();
    keyCache = { secret, key };
  }
  return keyCache.key;
}

type Session = { a: string; k: string; f: string; r: string; s: string; e: number };

async function mint(secret: string, session: Session) {
  const payload = base64url(enc.encode(JSON.stringify(session)));
  const mac = await crypto.subtle.sign('HMAC', await tokenKey(secret), enc.encode(payload));
  return `ysh_${payload}.${base64url(new Uint8Array(mac))}`;
}

const fromBase64url = (text: string) =>
  fromBase64(
    text
      .replace(/-/g, '+')
      .replace(/_/g, '/')
      .padEnd(Math.ceil(text.length / 4) * 4, '='),
  );

/** Whether a smart-HTTP request carries a session token (as a bearer). */
export const sshBearer = (req: Request) => {
  const header = req.headers.get('authorization') ?? '';
  return header.startsWith('Bearer ysh_') ? header.slice(7) : null;
};

/** The grant behind a session token for this repository and service, or null: forged,
 * expired, for another repository or service, or its key is no longer live. */
export async function verifySshToken(
  env: Env,
  token: string,
  repo: string,
  service: string,
): Promise<{ _pat: PatGrant } | null> {
  const secret = secretOf(env);
  const parts = TOKEN.exec(token);
  if (!secret || !parts) return null;
  let session: Session;
  try {
    const valid = await crypto.subtle.verify(
      'HMAC',
      await tokenKey(secret),
      fromBase64url(parts[2]),
      enc.encode(parts[1]),
    );
    if (!valid) return null;
    session = JSON.parse(new TextDecoder().decode(fromBase64url(parts[1])));
  } catch {
    return null;
  }
  if (!(session.e > Date.now()) || session.r !== repo || session.s !== service) return null;
  const checked = await checkKey(env, session.a, session.k, session.f);
  if (!checked) return null;
  const orgs = await orgAccess(env, session.a, checked.orgs);
  return {
    _pat: {
      workspace: session.a,
      principal: `user:${session.a}`,
      id: session.k,
      scopes: SCOPES[service],
      repos: [repo],
      org: null,
      ...(orgs && { orgs }),
    },
  };
}

/** `/internal/ssh/*`: answers only the gateway (a valid JWT); 404 where SSH is off. */
export async function sshInternal(req: Request, env: Env): Promise<Response> {
  const secret = secretOf(env);
  const url = new URL(req.url);
  if (!secret || req.method !== 'POST') return error('NOT_FOUND', 'Not found', 404);
  const jwt = (req.headers.get('authorization') ?? '').replace(/^Bearer /, '');
  try {
    await jwtVerify(jwt, enc.encode(secret), {
      algorithms: ['HS256'],
      issuer: 'yoneda-ssh-gateway',
      audience: 'yoneda-platform',
      maxTokenAge: '2m',
    });
  } catch {
    return error('UNAUTHORIZED', 'Gateway credentials required', 401);
  }
  let body: Json;
  try {
    body = await req.json<Json>();
  } catch {
    return error('INVALID_INPUT', 'JSON body required', 400);
  }
  const fingerprint = String(body.fingerprint ?? '');
  if (!FINGERPRINT.test(fingerprint)) return error('INVALID_INPUT', 'Invalid fingerprint', 400);
  if (url.pathname === '/internal/ssh/lookup') {
    const found = await lookupKey(env, fingerprint);
    return found ? response(found) : error('NOT_FOUND', 'Unknown SSH key', 404);
  }
  if (url.pathname === '/internal/ssh/session') {
    const { account, key_id: keyId, repo, service } = body;
    if (
      typeof account !== 'string' ||
      !KEY_ID.test(String(keyId)) ||
      !REPO.test(String(repo)) ||
      !Object.hasOwn(SCOPES, String(service))
    )
      return error('INVALID_INPUT', 'account, key_id, repo and service required', 400);
    if (!(await checkKey(env, account, keyId, fingerprint)))
      return error('UNAUTHORIZED', 'Unknown or removed SSH key', 401);
    const expires = Date.now() + TOKEN_TTL_MS;
    const session = { a: account, k: keyId, f: fingerprint, r: repo, s: service, e: expires };
    return response({ token: await mint(secret, session), expires_at: expires });
  }
  return error('NOT_FOUND', 'Not found', 404);
}
