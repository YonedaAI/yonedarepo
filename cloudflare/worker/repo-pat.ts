// Personal access tokens (`ypat_…`): account-wide bearer credentials for CLIs and agents.
// The account's WorkspaceAuthority holds each token's digest, scopes, allowlist and expiry
// and is asked on every request (strict: no cache), through a D1 lookup from digest to
// account. The SourceRepository maps the scopes (`_pat` credentials) onto its own.
import { type OrgAccess, orgAccess } from './platform-org-access';
import { ApiError, type Json } from './repo-ops';
import { toBase64 } from './repo-stores';
import type { Env } from './types';
import { workspace } from './workspace';

export const PAT_SCOPES = [
  'repo:read',
  'repo:write',
  'repo:land',
  'repo:review',
  'repo:admin',
] as const;
export type PatScope = (typeof PAT_SCOPES)[number];
/** A verified personal token, as the adapter passes it to the platform. */
export type PatGrant = {
  workspace: string;
  /** `user:<account>`: the account acts, never as a person (no break-glass). */
  principal: string;
  id: string;
  scopes: PatScope[];
  /** Repository allowlist; `null`: every repository of the account. */
  repos: string[] | null;
  /** The one organization whose repositories the token is limited to; `null`: none. */
  org: string | null;
  /** The account's organizations as their authorities answered for this request. */
  orgs?: OrgAccess;
};
export type Pat = { _pat: PatGrant };

const FORMAT = /^ypat_[A-Za-z0-9_-]{43}$/;
export const base64url = (bytes: Uint8Array) =>
  toBase64(bytes).replace(/[+/=]/g, (c) => ({ '+': '-', '/': '_', '=': '' })[c] ?? '');
const hex = (bytes: Uint8Array) => [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
/** SHA-256 of a secret, in hex: what the authorities store instead of the secret. */
export const sha = async (secret: string) =>
  hex(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(secret))));

/** The account and grant behind a `ypat_` bearer, or null (unknown, expired, revoked). */
export async function verifyPat(env: Env, token: string): Promise<PatGrant | null> {
  if (!FORMAT.test(token)) return null;
  const tokenHash = await sha(token);
  const row = await env.INDEX.prepare('SELECT workspace FROM platform_tokens WHERE token_hash=?')
    .bind(tokenHash)
    .first<{ workspace: string }>();
  if (!row) return null;
  const checked = await workspace(env, row.workspace, {
    op: 'pat_check',
    token_hash: tokenHash,
  }).catch((e) => {
    if (e?.code === 'UNAUTHORIZED') return null;
    // Refused, not revoked: the lookup row stays for the account's unsuspension.
    if (e?.code === 'ACCOUNT_SUSPENDED') throw new ApiError(e.code, 'This account is suspended');
    throw e;
  });
  if (!checked) {
    // The account refused it for good (expired or revoked): drop the lookup row.
    await env.INDEX.prepare('DELETE FROM platform_tokens WHERE token_hash=?').bind(tokenHash).run();
    return null;
  }
  const org: string | null = checked.org ?? null;
  // An org-limited token acts only through that org.
  const hints: string[] = (checked.orgs ?? []).filter((o: string) => !org || o === org);
  const orgs = await orgAccess(env, row.workspace, hints);
  return {
    workspace: row.workspace,
    principal: `user:${row.workspace}`,
    id: checked.id,
    scopes: checked.scopes,
    repos: checked.repos ?? null,
    org,
    ...(orgs && { orgs }),
  };
}

/** Issues a token to `account` (the caller authenticated the account itself) and returns
 * its secret, once. The authority validates the grant; the lookup row follows its commit. */
/** How a token was made: `yoneda login` on `host` (the device flow only; never a caller's
 * claim), or on the website (no label). */
export type PatLabel = { origin: 'login'; host: string | null };

export async function issuePat(env: Env, account: string, request: Json, label?: PatLabel) {
  const token = `ypat_${base64url(crypto.getRandomValues(new Uint8Array(32)))}`;
  const id = `pat_${hex(crypto.getRandomValues(new Uint8Array(8)))}`;
  const tokenHash = await sha(token);
  const created = await workspace(env, account, {
    op: 'pat_create',
    id,
    name: request.name,
    token_hash: tokenHash,
    scopes: request.scopes,
    repos: request.repos ?? null,
    org: request.org ?? null,
    expires_days: request.expires_days ?? 30,
    origin: label?.origin ?? null,
    host: label?.host ?? null,
  });
  await env.INDEX.prepare(
    'INSERT INTO platform_tokens(token_hash,workspace,id,expires_at) VALUES(?,?,?,?)',
  )
    .bind(tokenHash, account, id, created.expires_at)
    .run();
  return {
    id,
    token,
    name: created.name,
    scopes: created.scopes,
    repos: created.repos,
    org: created.org ?? null,
    origin: created.origin ?? null,
    host: created.host ?? null,
    expires_at: created.expires_at,
  };
}

/** Revokes one of `account`'s tokens; its lookup row goes with it. */
export async function revokePat(env: Env, account: string, id: string) {
  const revoked = await workspace(env, account, { op: 'pat_revoke', id });
  await env.INDEX.prepare('DELETE FROM platform_tokens WHERE workspace=? AND id=?')
    .bind(account, id)
    .run();
  return revoked;
}

const isPat = (auth: unknown): auth is Pat =>
  typeof auth === 'object' && auth !== null && '_pat' in auth;

/** Refuses a personal token without `scope`; other credentials pass (the authority decides). */
export function requirePatScope(auth: unknown, scope: PatScope) {
  if (isPat(auth) && !auth._pat.scopes.includes(scope))
    throw new ApiError('FORBIDDEN', `Token lacks the ${scope} scope`);
}
