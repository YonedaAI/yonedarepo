// Which account a verified provider identity signs in to, links to, or creates. Identities
// are keyed by (provider, provider user id) on claim instances of the account authority
// (`identity:<provider>:<subject>`), and verified emails by digest (`email:<sha256>`); like
// SSH fingerprint claims, a claim is re-checked with its account, so a stale one grants
// nothing. A matching email never merges accounts: the person signs in to the existing
// account and links the provider there.
import { isReservedHandle, normalizeAccountIdentifier } from '../../shared/account';
import { accountCreated } from './account-email';
import type { ProviderIdentity } from './oauth-providers';
import { sha } from './storage';
import type { Env, Json } from './types';
import { workspace } from './workspace';

/** What the callback does next; an `error` is a code the sign-in page explains. */
export type Outcome =
  | { kind: 'signed_in'; username: string; created?: true }
  | { kind: 'linked' }
  | { kind: 'error'; code: 'email_in_use' | 'identity_taken' | 'busy' | 'unavailable' };

/** A claim younger than this whose account does not exist yet is another sign-in creating it. */
export const PENDING_MS = 2 * 60 * 1000;

const identityKey = (i: ProviderIdentity) => `identity:${i.provider}:${i.subject}`;
export const emailKey = async (email: string) => `email:${await sha(email)}`;
const fields = (i: ProviderIdentity) => ({
  provider: i.provider,
  subject: i.subject,
  login: printable(i.login) || i.provider,
  email: i.email,
  avatar_url: i.avatar,
});

export async function claims(env: Env, key: string, command: Json): Promise<Json> {
  const response = await env.WORKSPACES.get(env.WORKSPACES.idFromName(key)).fetch(
    'http://workspace/command',
    { method: 'POST', body: JSON.stringify({ ...command, key }) },
  );
  const value = await response.json<Json>();
  if (!response.ok)
    throw Object.assign(new Error(value.error?.message ?? 'Identity lookup failed'), {
      code: value.error?.code ?? 'IDENTITY_FAILED',
    });
  return value;
}

/** The claim on a key, or null. */
export async function holder(
  env: Env,
  key: string,
): Promise<{ account: string; claimed_at: number } | null> {
  return claims(env, key, { op: 'identity_claim_get' }).then(
    (held) => held as { account: string; claimed_at: number },
    (e) => {
      if (e?.code === 'NOT_FOUND') return null;
      throw e;
    },
  );
}

const linkedTo = async (env: Env, account: string, i: ProviderIdentity) =>
  (
    await workspace(env, account, {
      op: 'identity_check',
      provider: i.provider,
      subject: i.subject,
    })
  ).linked === true;
export const accountExists = async (env: Env, account: string) =>
  (await workspace(env, account, { op: 'account_exists' })).exists === true;

/** Signs in with an identity: its account, a refusal, or a new account named after it. */
export async function signInWith(
  env: Env,
  identity: ProviderIdentity,
  sessionHash: string,
): Promise<Outcome> {
  const key = identityKey(identity);
  const held = await holder(env, key);
  let replace = false;
  if (held) {
    if (await linkedTo(env, held.account, identity)) {
      const signed = await workspace(env, held.account, {
        op: 'identity_signin',
        provider: identity.provider,
        subject: identity.subject,
        session_hash: sessionHash,
        // Each sign-in refreshes the provider's picture (an uploaded one still wins).
        avatar_url: identity.avatar,
      });
      return signed.authenticated
        ? { kind: 'signed_in', username: held.account }
        : { kind: 'error', code: 'unavailable' };
    }
    if (Date.now() - held.claimed_at < PENDING_MS && !(await accountExists(env, held.account)))
      return { kind: 'error', code: 'busy' };
    replace = true; // left behind by an unlink or a failed signup
  }
  if (identity.email && (await emailTaken(env, identity.email)))
    return { kind: 'error', code: 'email_in_use' };
  for (const name of candidates(identity)) {
    if (await accountExists(env, name)) continue;
    const claimed = await claims(env, key, { op: 'identity_claim', account: name, replace });
    if (!claimed.claimed) return { kind: 'error', code: 'busy' };
    replace = true; // the claim is ours now; a lost name race moves it to the next name
    try {
      await workspace(env, name, {
        op: 'identity_signup',
        username: name,
        session_hash: sessionHash,
        ...fields(identity),
      });
    } catch (e: any) {
      if (e?.code === 'ALREADY_EXISTS') continue;
      throw e;
    }
    if (identity.email)
      await claims(env, await emailKey(identity.email), { op: 'identity_claim', account: name });
    // A new account only: later sign-ins and links never welcome again.
    await accountCreated(env, name, identity.email, identity.provider);
    return { kind: 'signed_in', username: name, created: true };
  }
  return { kind: 'error', code: 'unavailable' };
}

/** Links an identity to the account whose session started the attempt. */
export async function linkTo(
  env: Env,
  identity: ProviderIdentity,
  account: string,
  sessionHash: string,
): Promise<Outcome | { kind: 'error'; code: 'session' | 'provider_linked' }> {
  const key = identityKey(identity);
  const held = await holder(env, key);
  const live = held ? await linkedTo(env, held.account, identity) : false;
  if (held && live && held.account !== account) return { kind: 'error', code: 'identity_taken' };
  if (held && !live && held.account !== account) {
    if (Date.now() - held.claimed_at < PENDING_MS && !(await accountExists(env, held.account)))
      return { kind: 'error', code: 'busy' };
  }
  const claimed = await claims(env, key, { op: 'identity_claim', account, replace: true });
  if (!claimed.claimed) return { kind: 'error', code: 'busy' };
  try {
    await workspace(env, account, {
      op: 'identity_link',
      session_hash: sessionHash,
      ...fields(identity),
    });
  } catch (e: any) {
    if (!live) await claims(env, key, { op: 'identity_claim_release', account }).catch(() => {});
    if (e?.code === 'UNAUTHORIZED') return { kind: 'error', code: 'session' };
    if (e?.code === 'ALREADY_EXISTS') return { kind: 'error', code: 'provider_linked' };
    throw e;
  }
  if (identity.email)
    await claims(env, await emailKey(identity.email), { op: 'identity_claim', account });
  return { kind: 'linked' };
}

/** Unlinks the account's identity from a provider, then releases its claims. */
export async function unlink(env: Env, account: string, provider: string) {
  const removed = await workspace(env, account, { op: 'identity_unlink', provider });
  await claims(env, `identity:${removed.provider}:${removed.subject}`, {
    op: 'identity_claim_release',
    account,
  }).catch(() => {}); // a claim left behind grants nothing (sign-in re-checks the account)
  if (typeof removed.email === 'string' && !removed.email_kept)
    await claims(env, await emailKey(removed.email), {
      op: 'identity_claim_release',
      account,
    }).catch(() => {});
  return { provider: removed.provider, unlinked: true };
}

/** Whether a live account holds the email: one named by it, or one whose identity carries it. */
export async function emailTaken(env: Env, email: string) {
  const named = normalizeAccountIdentifier(email);
  if (named && (await accountExists(env, named))) return true;
  const held = await holder(env, await emailKey(email));
  return held !== null && (await accountExists(env, held.account));
}

/** Usernames to try for a new account: the provider handle, then numbered, then random. */
export function candidates(identity: ProviderIdentity): string[] {
  let base = printable(identity.login)
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 26)
    .replace(/_+$/, '');
  if (!/^[a-z]/.test(base)) base = `${identity.provider === 'github' ? 'gh' : 'user'}_${base}`;
  if (base.length < 3) base = `${base}_user`.replace(/__+/g, '_');
  base = base.slice(0, 26).replace(/_+$/, '');
  const numbered = [2, 3, 4, 5, 6, 7, 8, 9].map((n) => `${base}${n}`);
  const random = [0, 1, 2].map(
    () =>
      `${base}_${[...crypto.getRandomValues(new Uint8Array(2))].map((b) => b.toString(16).padStart(2, '0')).join('')}`,
  );
  return [base, ...numbered, ...random].filter(
    (n) => normalizeAccountIdentifier(n) === n && !isReservedHandle(n),
  );
}

const printable = (value: string) => value.replace(/[^\x21-\x7e]/g, '').slice(0, 100);
