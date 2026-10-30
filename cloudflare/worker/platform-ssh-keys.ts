// SSH keys for Git over SSH (`/api/v1/ssh-keys[/:id]`). The account's WorkspaceAuthority
// holds its keys and is the authority on whether one is live; one authority instance per
// fingerprint (`sshkey:<SHA256 fingerprint>`, same class and schema) maps a key to the
// account that registered it, so the gateway's lookup is strongly consistent. A lookup
// always re-checks the key with its account: removal there is the revocation, effective at
// once, and a claim left behind by a failure grants nothing.
import { frontDoor } from './platform-ssh-gateway';
import { ApiError, type Credentials, type Json } from './repo-ops';
import { patHolds, requirePatScope } from './repo-pat';
import type { Env } from './types';
import { workspace } from './workspace';

const hex = (bytes: Uint8Array) => [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');

/** The fingerprint index instance for one key. */
async function index(env: Env, fingerprint: string, command: Json): Promise<Json> {
  const response = await env.WORKSPACES.get(
    env.WORKSPACES.idFromName(`sshkey:${fingerprint}`),
  ).fetch('http://workspace/command', {
    method: 'POST',
    body: JSON.stringify({ ...command, fingerprint }),
  });
  const value = await response.json<Json>();
  if (!response.ok) throw new ApiError(value.error?.code ?? 'SSH_KEY_FAILED', value.error?.message);
  return value;
}

/** What a key does on every repository of the account (`platform-ssh.ts`). */
const KEY_REACH = ['repo:read', 'repo:write', 'repo:land'] as const;

/** The account whose keys `auth` manages: a signed-in person, or a token with
 * `account:ssh-keys` or `repo:admin`. A key reaches every repository of the account, so
 * adding one needs a token that already does as much: no repository or organization limit,
 * and every scope a key acts with. Without that rule the narrow scope alone would be full
 * Git access. */
function manager(auth: Credentials, adding: boolean): string {
  if ('_pat' in auth) {
    const admin = patHolds(auth, 'repo:admin');
    if (!admin) requirePatScope(auth, 'account:ssh-keys');
    if (adding && (auth._pat.repos !== null || auth._pat.org !== null))
      throw new ApiError('FORBIDDEN', 'Adding an SSH key needs a token for all repositories');
    if (adding && !admin && !KEY_REACH.every((scope) => patHolds(auth, scope)))
      throw new ApiError(
        'FORBIDDEN',
        `Adding an SSH key needs ${KEY_REACH.join(', ')}: a key does all three`,
      );
    return auth._pat.workspace;
  }
  if ('_session' in auth && auth._session.human) return auth._session.workspace;
  throw new ApiError('UNAUTHORIZED', 'Sign in to your account to manage SSH keys');
}

/** `/api/v1/ssh-keys[/:id]` for an authenticated caller. */
export async function sshKeyRoute(
  env: Env,
  auth: Credentials,
  method: string,
  id: string | undefined,
  body: () => Promise<Json>,
): Promise<Json> {
  if (!id && method === 'GET') {
    const listed = await workspace(env, manager(auth, false), { op: 'ssh_key_list' });
    return { keys: listed.keys, ssh: sshAccess(env) };
  }
  if (!id && method === 'POST')
    return { ...(await addKey(env, manager(auth, true), await body())), ssh: sshAccess(env) };
  if (id && method === 'DELETE') return removeKey(env, manager(auth, false), id);
  throw new ApiError('NOT_FOUND', 'Unknown API path');
}

/** How clients reach Git over SSH: the front door, the host, a clone URL template and, on
 * the tunnel, the `~/.ssh/config` entry that makes plain `ssh`/`git` use cloudflared. */
export function sshAccess(env: Env) {
  const door = frontDoor(env);
  const host = env.SSH_HOST && /^[a-z0-9.-]+$/.test(env.SSH_HOST) ? env.SSH_HOST : null;
  if (!door || !host) return { front_door: null, host: null, clone_url: null, ssh_config: null };
  return {
    front_door: door,
    host,
    clone_url: `ssh://git@${host}/<repository id>.git`,
    ssh_config:
      door === 'tunnel'
        ? `Host ${host}\n  ProxyCommand cloudflared access ssh --hostname %h\n`
        : null,
  };
}

/** Adds a key to the account, then claims its fingerprint. A fingerprint another account
 * holds with a live key refuses the add (and undoes it); a claim whose key is gone is
 * taken over. */
async function addKey(env: Env, account: string, request: Json) {
  const id = `ssh_${hex(crypto.getRandomValues(new Uint8Array(8)))}`;
  const added = await workspace(env, account, {
    op: 'ssh_key_add',
    id,
    title: request.title,
    public_key: request.key,
  });
  const claim = { op: 'ssh_fp_claim', account, key_id: id };
  let claimed = await index(env, added.fingerprint, claim);
  if (!claimed.claimed && !(await live(env, claimed.holder, added.fingerprint)))
    claimed = await index(env, added.fingerprint, { ...claim, replace: true });
  if (!claimed.claimed) {
    await workspace(env, account, { op: 'ssh_key_remove', id });
    throw new ApiError('ALREADY_EXISTS', 'This key is already in use by an account');
  }
  return added;
}

/** Removes a key: the account's removal is the revocation; the claim's release follows. */
async function removeKey(env: Env, account: string, id: string) {
  const removed = await workspace(env, account, { op: 'ssh_key_remove', id });
  await index(env, removed.fingerprint, { op: 'ssh_fp_release', account, key_id: id }).catch(
    () => {}, // a claim left behind grants nothing (lookups re-check the account)
  );
  return { id, deleted: true };
}

/** A live key's check (account, organizations as hinted), or null when it is not live. */
async function live(
  env: Env,
  holder: { account: string; key_id: string },
  fingerprint: string,
): Promise<Json | null> {
  return workspace(env, holder.account, {
    op: 'ssh_key_check',
    key_id: holder.key_id,
    fingerprint,
  }).catch((e) => {
    if (['UNAUTHORIZED', 'NOT_FOUND', 'ACCOUNT_SUSPENDED'].includes(e?.code)) return null;
    throw e;
  });
}

/** The account and key behind a fingerprint, or null: unknown, or no longer live. */
export async function lookupKey(env: Env, fingerprint: string) {
  const holder = await index(env, fingerprint, { op: 'ssh_fp_get' }).catch((e) => {
    if (e?.code === 'NOT_FOUND') return null;
    throw e;
  });
  if (!holder) return null;
  const checked = await live(env, holder as { account: string; key_id: string }, fingerprint);
  return checked && { account: holder.account as string, key_id: holder.key_id as string };
}

/** Re-checks one key with its account: its organization hints when live, else null. */
export async function checkKey(env: Env, account: string, keyId: string, fingerprint: string) {
  const checked = await live(env, { account, key_id: keyId }, fingerprint);
  return checked && { orgs: (checked.orgs ?? []) as string[] };
}
