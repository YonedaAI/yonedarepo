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
// An organization can't be proved this way: its installation names no person. It goes on to the
// sign-in OAuth app, which asks GitHub whether this person is an active owner
// (oauth-github-org.ts), and a ticket carries what the platform read across. docs/clone-import.md
// has why. An account holds its own installation and any number of organizations'.

import { newTicket } from './github-org-ticket';
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
import { sha } from './storage';
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

const onOrganization = (seen: Installation) =>
  seen.target_type === 'Organization' && seen.account?.type === 'Organization';

/** On to the sign-in that proves an owner, with what the platform just read of the installation. */
async function proveOwner(env: Env, url: URL, account: string, seen: Installation) {
  const ticket = newTicket(account);
  await workspace(env, account, {
    op: 'github_org_ticket_put',
    ticket_hash: await sha(ticket.secret),
    installation: seen.id,
    login: seen.account?.login,
    target_id: seen.account?.id,
  });
  const value = encodeURIComponent(ticket.value);
  return redirect(`${url.origin}/auth/github/start?intent=github_org&ticket=${value}`);
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

/** GitHub's page for an installation, where a person changes its repositories. GitHub names it
 * in the installation, on the right account's settings; the docs give no address to build, so
 * these are only for an answer without one, and nothing but github.com is ever linked. */
function managePage(row: Held, seen: Installation | null) {
  const named = seen?.html_url;
  if (named?.startsWith('https://github.com/')) return named;
  const owner =
    row.target_type === 'Organization' ? `organizations/${encodeURIComponent(row.login)}/` : '';
  return `https://github.com/${owner}settings/installations/${row.installation}`;
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
  // A member asked: GitHub waits on an owner's approval, and nothing is installed yet.
  if (asked.get('setup_action') === 'request') return back(url, 'requested');
  const id = Number(asked.get('installation_id'));
  if (!Number.isSafeInteger(id) || id <= 0) return back(url, 'state');
  if (!(await linkedLogin(env, account))) return redirect(`${url.origin}${LINK}`);
  const seen = await installationById(env, id).catch((e) => {
    if (accessGone(e)) return null;
    throw e;
  });
  if (seen && onOrganization(seen))
    return seen.suspended_at ? back(url, 'lost') : proveOwner(env, url, account, seen);
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
        manageUrl: managePage(row, seen),
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
  return { state: 'ok' as const, installation, login: pick.login, type, manageUrl: pick.manageUrl };
}

/** The installation `account` may use right now. */
export const connection = async (env: Env, account: string, wanted?: number) =>
  chosen(await proven(env, account), wanted);

/** `GET /github/repositories`: what the import dialog shows. */
export async function githubRepositories(env: Env, auth: Credentials, wanted?: number) {
  if (!githubAppOn(env)) return { available: false };
  const rows = await proven(env, personOf(auth));
  const held = chosen(rows, wanted);
  const installations = rows
    .filter((r) => r.ok)
    .map((r) => ({ id: r.row.installation, login: r.login, type: r.row.target_type }));
  const offered = installations.length ? { installations } : {};
  if (held.state !== 'ok') return { available: true, connection: held.state, ...offered };
  try {
    const listed = await installationRepositories(env, held.installation);
    const { installation, login, manageUrl: manage_url } = held;
    const named = { login, installation, manage_url };
    return { available: true, connection: 'ok', ...named, ...offered, ...listed };
  } catch (e) {
    if (accessGone(e)) return { available: true, connection: 'lost', ...offered };
    throw e;
  }
}
