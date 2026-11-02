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
// An organization names no person, so GitHub is asked whether the linked GitHub user is on one of
// its repositories (platform-github-org.ts). An account holds its own installation and any number
// of organizations'.

import { hmacHex } from './hmac';
import { log } from './log';
import {
  githubAppOn,
  type Installation,
  installationById,
  installationOfUser,
  installationRepositories,
} from './platform-github-app';
import { joinOrganization, joinReachable, onOrganization } from './platform-github-org';
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
export async function linkedLogin(env: Env, account: string): Promise<string | null> {
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

type Held = {
  installation: number;
  login: string;
  target_type: 'User' | 'Organization';
  target_id: number | null;
  connected_by: string | null;
};

/** Whether `seen` is still what `row` proved. An organization's is read again, and needs the
 * GitHub user who proved it still linked here. */
async function stillHeld(env: Env, account: string, row: Held, seen: Installation) {
  if (row.target_type === 'User') return (await proof(env, account, seen)) === 'connected';
  if (!onOrganization(seen) || seen.account?.id !== row.target_id || seen.suspended_at)
    return false;
  const { linked } = await workspace(env, account, {
    op: 'identity_check',
    provider: 'github',
    subject: row.connected_by,
  });
  return linked === true;
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
  // `add`: another account or organization, past the one already there.
  const adding = url.searchParams.get('add') === '1';
  const found = adding ? null : await installationOfUser(env, login);
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
  const login = await linkedLogin(env, account);
  // GitHub stops someone who isn't an owner here: nothing new is installed, though the App may
  // already be on an organization they can reach.
  if (asked.get('setup_action') === 'request') {
    const joined = login ? await joinReachable(env, account, login) : false;
    return back(url, joined ? 'connected' : 'requested');
  }
  const id = Number(asked.get('installation_id'));
  if (!Number.isSafeInteger(id) || id <= 0) return back(url, 'state');
  if (!login) return redirect(`${url.origin}${LINK}`);
  const seen = await installationById(env, id).catch((e) => {
    if (accessGone(e)) return null;
    throw e;
  });
  if (seen && onOrganization(seen))
    return back(
      url,
      seen.suspended_at ? 'lost' : await joinOrganization(env, account, login, seen),
    );
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

/** Each installation `account` connected, with whether it still holds. */
async function proven(env: Env, account: string) {
  const { installations } = await workspace(env, account, { op: 'github_installation_list' });
  return Promise.all(
    (installations as Held[]).map(async (row) => {
      const seen = await installationById(env, row.installation).catch((e) => {
        if (accessGone(e)) return null;
        throw e;
      });
      const ok = seen ? await stillHeld(env, account, row, seen) : false;
      return {
        row,
        ok,
        login: seen?.account?.login ?? row.login,
      };
    }),
  );
}

type Proven = Awaited<ReturnType<typeof proven>>;

/** `wanted`, or the first that holds. `none`: never connected. `lost`: removed, suspended, or no
 * longer on the GitHub user this account links. */
function chosen(rows: Proven, wanted?: number) {
  const pick = wanted
    ? rows.find((r) => r.row.installation === wanted)
    : (rows.find((r) => r.ok) ?? rows[0]);
  if (!pick) return { state: 'none' as const };
  if (!pick.ok) return { state: 'lost' as const };
  const { installation, target_type: type } = pick.row;
  return { state: 'ok' as const, installation, login: pick.login, type };
}

/** The installation `account` may use right now. */
export const connection = async (env: Env, account: string, wanted?: number) =>
  chosen(await proven(env, account), wanted);

/** One installation's repositories, each saying which it came through; nothing if it's gone. */
async function listOf(env: Env, account: string, { row }: Proven[number]) {
  const person =
    row.target_type === 'Organization' ? ((await linkedLogin(env, account)) ?? '') : undefined;
  const { installation } = row;
  return installationRepositories(env, installation, person).then(
    ({ repositories, more }) => ({
      repositories: repositories.map((r) => ({ ...r, installation })),
      more,
    }),
    (e) => {
      if (accessGone(e)) return { repositories: [], more: false };
      throw e;
    },
  );
}

/** `GET /github/repositories`: everything the import dialog can offer, an account's own first and
 * then each organization's, so one search covers them all. */
export async function githubRepositories(env: Env, auth: Credentials) {
  if (!githubAppOn(env)) return { available: false };
  const account = personOf(auth);
  const rows = await proven(env, account);
  const held = rows.filter((r) => r.ok);
  if (!held.length) return { available: true, connection: chosen(rows).state };
  const lists = await Promise.all(held.map((r) => listOf(env, account, r)));
  const seen = new Set<number>();
  const repositories = lists
    .flatMap((list) => list.repositories)
    .filter((r) => !seen.has(r.id) && seen.add(r.id));
  const { row, login } = held[0] as Proven[number];
  return {
    available: true,
    connection: 'ok',
    login,
    installation: row.installation,
    repositories,
    more: lists.some((list) => list.more),
  };
}
