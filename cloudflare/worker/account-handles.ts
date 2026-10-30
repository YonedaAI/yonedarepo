// The handle an email-named account picks (accounts made before sign-up named accounts by
// handle are named by their address, which never goes in a URL): held on the handle's own
// authority instance first (one namespace with usernames and org names), then recorded by
// the account, the one it replaces released, and projected for listings. Other accounts'
// handle is their name.
import { isReservedHandle, normalizeAccountIdentifier } from '../../shared/account';
import { candidates } from './oauth-identity';
import type { ProviderIdentity } from './oauth-providers';
import type { Env, Json } from './types';
import { workspace } from './workspace';

const fail = (code: string, message: string) => Object.assign(new Error(message), { code });

/** The account's handle (null while an email-named account has none), and while it has
 * none a free one made from its GitHub login (`handle_suggestion`). */
export async function handleState(env: Env, account: string): Promise<Json> {
  const { handle } = await workspace(env, account, { op: 'handle_get' });
  if (handle) return { handle, handle_suggestion: null };
  return { handle: null, handle_suggestion: await suggestion(env, account) };
}

async function suggestion(env: Env, account: string): Promise<string | null> {
  const { identities } = await workspace(env, account, { op: 'identity_list' }).catch(() => ({
    identities: [],
  }));
  const github = (identities as Json[]).find((i) => i.provider === 'github');
  if (!github?.login) return null;
  const tried = candidates({ provider: 'github', login: github.login } as ProviderIdentity);
  for (const name of tried.slice(0, 3)) if (!(await held(env, name))) return name;
  return null;
}

/** Whether `name` is a handle someone holds (repo-paths' ownerOf, asked directly so the front
 * Worker, which serves sign-in, never imports the platform's repo modules). */
const held = (env: Env, name: string) =>
  workspace(env, name, { op: 'handle_lookup' }).then(
    () => true,
    (e) => (e?.code === 'NOT_FOUND' ? false : Promise.reject(e)),
  );

/** `PUT /api/auth/handle {handle}` for an email-named account: HANDLE_INVALID,
 * HANDLE_RESERVED, HANDLE_TAKEN, or HANDLE_FIXED for an account named by its handle. */
export async function setHandle(env: Env, account: string, requested: unknown): Promise<Json> {
  const name = typeof requested === 'string' ? normalizeAccountIdentifier(requested) : null;
  if (!name || name.includes('@'))
    throw fail(
      'HANDLE_INVALID',
      'Handles are 3–32 letters, digits or underscores, starting with a letter',
    );
  if (isReservedHandle(name))
    throw fail('HANDLE_RESERVED', `${name} is reserved for the website's own pages`);
  if (!account.includes('@')) throw fail('HANDLE_FIXED', "This account's handle is its name");
  await workspace(env, name, { op: 'handle_reserve', handle: name, account });
  let set: Json;
  try {
    set = await workspace(env, account, { op: 'handle_set', handle: name });
  } catch (e) {
    await workspace(env, name, { op: 'handle_release', account }).catch(() => {});
    throw e;
  }
  if (set.previous && set.previous !== name)
    await workspace(env, String(set.previous), { op: 'handle_release', account }).catch(() => {});
  await env.INDEX.prepare(
    'INSERT INTO platform_handles(workspace,handle) VALUES(?,?) ON CONFLICT(workspace) DO UPDATE SET handle=excluded.handle',
  )
    .bind(account, name)
    .run();
  return { handle: name };
}
