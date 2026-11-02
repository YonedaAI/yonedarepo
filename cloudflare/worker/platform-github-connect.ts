// Connecting GitHub: the browser's trip to the App's install page and back, and the proof behind
// every use. GitHub's redirect carries an `installation_id` anyone can forge, so nothing trusts
// it: GitHub is asked who that installation is on, and it counts only on the GitHub user this
// account linked by signing in with GitHub. The same proof runs on every use, as a link can be
// undone and an installation removed.
//
// The session cookie is SameSite=Strict, so it does not come back from github.com. A signed
// state names the account instead, and a Lax cookie set on the way out ties it to this browser,
// as sign-in's binding does (oauth.ts). The app's page after that finds its session as any
// page does, by asking: `/settings`, which needs nothing of the document's own request.
//
// An installation on an organization is refused. Proving a person belongs to it takes either
// the App's Members permission or a user token from the App, and it has neither.
// docs/clone-import.md has what would change that.

import { hmacHex } from './hmac';
import { log } from './log';
import {
  githubAppOn,
  type Installation,
  installationById,
  installationOfUser,
  installationRepositories,
} from './platform-github-app';
import { accessGone } from './platform-github-refused';
import { ApiError, type Credentials, type Json } from './repo-ops';
import type { Env } from './types';
import { workspace } from './workspace';

/** How long a person has on GitHub's pages. */
const STATE_MS = 30 * 60_000;
const PAGE = /^\/api\/v1\/github\/(connect|connected)$/;
const LINK = '/auth/github/start?intent=link';
/** Ties a state to the browser that left with it. Only these paths ever receive it. */
const BINDING = 'yoneda_github';

export const isGitHubPage = (url: URL) => PAGE.test(url.pathname);

const redirect = (location: string) =>
  new Response(null, {
    status: 302,
    headers: { location, 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' },
  });
/** Back to the app, whose import dialog reads `github`. */
const back = (url: URL, result: string) => redirect(`${url.origin}/settings?github=${result}`);

function bindingCookie(url: URL, value: string) {
  const secure = url.protocol === 'https:' ? '; Secure' : '';
  const age = value ? STATE_MS / 1000 : 0;
  return `${BINDING}=${value}; Path=/github/; HttpOnly; SameSite=Lax; Max-Age=${age}${secure}`;
}

const readBinding = (req: Request) =>
  req.headers
    .get('cookie')
    ?.split(';')
    .map((v) => v.trim())
    .find((v) => v.startsWith(`${BINDING}=`))
    ?.slice(BINDING.length + 1) ?? '';

const encodeName = (account: string) => btoa(encodeURIComponent(account)).replaceAll('=', '');
const decodeName = (value: string) => {
  try {
    return decodeURIComponent(atob(value));
  } catch {
    return '';
  }
};

const seal = (env: Env, account: string, expires: number, binding: string) =>
  hmacHex(env.GITHUB_APP_PRIVATE_KEY as string, `github-connect:${account}:${expires}:${binding}`);

/** A state naming the account, its time and the browser's binding, signed: GitHub only carries it. */
async function signedState(env: Env, account: string, binding: string) {
  const expires = Date.now() + STATE_MS;
  const mac = await seal(env, account, expires, binding);
  return `${encodeName(account)}.${expires}.${mac}`;
}

/** The account a returning state names, if it is ours, in time and this browser's. */
async function stateAccount(env: Env, state: string | null, binding: string) {
  const [name, expires, mac] = (state ?? '').split('.');
  const account = decodeName(name ?? '');
  if (!account || !binding || !mac || !(Number(expires) > Date.now())) return null;
  const wanted = await seal(env, account, Number(expires), binding);
  const encoder = new TextEncoder();
  const [a, b] = [encoder.encode(mac), encoder.encode(wanted)];
  return a.byteLength === b.byteLength && crypto.subtle.timingSafeEqual(a, b) ? account : null;
}

/** The GitHub login this account linked, or null. */
async function linkedLogin(env: Env, account: string): Promise<string | null> {
  const { identities } = await workspace(env, account, { op: 'identity_list' });
  return (identities as Json[]).find((i) => i.provider === 'github')?.login ?? null;
}

/** What GitHub's own answer says of this account and `seen`. */
async function proof(env: Env, account: string, seen: Installation) {
  if (seen.target_type !== 'User' || seen.account?.type !== 'User') return 'org' as const;
  const subject = String(seen.account.id);
  const { linked } = await workspace(env, account, {
    op: 'identity_check',
    provider: 'github',
    subject,
  });
  if (linked !== true) return 'other_account' as const;
  return seen.suspended_at ? ('lost' as const) : ('connected' as const);
}

const keep = (env: Env, account: string, seen: Installation) =>
  workspace(env, account, {
    op: 'github_installation_put',
    installation: seen.id,
    login: seen.account?.login,
  });

/** `GET /github/connect`: to the link step, to GitHub's install page, or, as GitHub shows no
 * way back to someone who installed already, straight home with that installation. */
async function connect(env: Env, url: URL, account: string) {
  const login = await linkedLogin(env, account);
  if (!login) return redirect(`${url.origin}${LINK}`);
  const found = await installationOfUser(env, login);
  if (found && (await proof(env, account, found)) === 'connected') {
    await keep(env, account, found);
    return back(url, 'connected');
  }
  const binding = crypto.randomUUID();
  const state = encodeURIComponent(await signedState(env, account, binding));
  const going = redirect(
    `https://github.com/apps/${env.GITHUB_APP_SLUG?.trim()}/installations/new?state=${state}`,
  );
  going.headers.append('set-cookie', bindingCookie(url, binding));
  return going;
}

/** `GET /github/connected`: GitHub's redirect, believed only once GitHub has said the same. */
async function connected(env: Env, url: URL, binding: string) {
  const asked = url.searchParams;
  const account = await stateAccount(env, asked.get('state'), binding);
  if (!account) return back(url, 'state');
  // An organization's owner has yet to approve: nothing is installed.
  if (asked.get('setup_action') === 'request') return back(url, 'org');
  const id = Number(asked.get('installation_id'));
  if (!Number.isSafeInteger(id) || id <= 0) return back(url, 'state');
  if (!(await linkedLogin(env, account))) return redirect(`${url.origin}${LINK}`);
  const seen = await installationById(env, id).catch((e) => {
    if (accessGone(e)) return null;
    throw e;
  });
  const result = seen ? await proof(env, account, seen) : 'other_account';
  if (result === 'connected') await keep(env, account, seen as Installation);
  return back(url, result);
}

/** The browser's visits. Whatever fails, it lands back on a page that says so. */
export async function githubPage(req: Request, env: Env, url: URL, signed: Credentials | null) {
  if (!githubAppOn(env)) return new Response('Not found', { status: 404 });
  const leaving = url.pathname.endsWith('/connect');
  const person = signed && '_session' in signed && signed._session.human;
  if (leaving && !person) return redirect(`${url.origin}/signin`);
  try {
    if (leaving) return await connect(env, url, (signed as any)._session.workspace);
    const home = await connected(env, url, readBinding(req));
    home.headers.append('set-cookie', bindingCookie(url, ''));
    return home;
  } catch (e: any) {
    log.warn('github.connect_failed', { status: e?.status, code: e?.code });
    return back(url, 'unavailable');
  }
}

/** The person behind a request: connecting is a person's, in a browser. */
export function personOf(auth: Credentials) {
  if ('_session' in auth && auth._session.human) return auth._session.workspace;
  throw new ApiError('FORBIDDEN', 'Connect GitHub from the website');
}

/** The installation `account` may use right now. `none`: never connected. `lost`: removed,
 * suspended, or no longer on the GitHub user this account links. */
export async function connection(env: Env, account: string) {
  const row = await workspace(env, account, { op: 'github_installation_get' });
  if (!row.installation) return { state: 'none' as const };
  const seen = await installationById(env, row.installation).catch((e) => {
    if (accessGone(e)) return null;
    throw e;
  });
  const held = seen && (await proof(env, account, seen)) === 'connected';
  return held
    ? { state: 'ok' as const, installation: row.installation as number, login: row.login as string }
    : { state: 'lost' as const };
}

/** `GET /github/repositories`: what the import dialog shows. */
export async function githubRepositories(env: Env, auth: Credentials) {
  if (!githubAppOn(env)) return { available: false };
  const held = await connection(env, personOf(auth));
  if (held.state !== 'ok') return { available: true, connection: held.state };
  try {
    const listed = await installationRepositories(env, held.installation);
    return { available: true, connection: 'ok', login: held.login, ...listed };
  } catch (e) {
    if (accessGone(e)) return { available: true, connection: 'lost' };
    throw e;
  }
}
