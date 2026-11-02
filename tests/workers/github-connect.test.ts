// Connecting GitHub, against a fake GitHub. The forged redirect is the case that matters: the
// `installation_id` on the way back is anyone's to write, and someone else's installation must
// never reach an account. The Durable Objects and R2 are real.
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { platformFetch } from '../../cloudflare/worker/platform-routes';
import { pkcs8Of } from '../../cloudflare/worker/platform-github-app';
import { frontFetch } from '../../cloudflare/worker/front-routes';
import type { Env } from '../../cloudflare/worker/types';
import { workspace } from '../../cloudflare/worker/workspace';
import { FakeGitHub, linkGitHub } from './fake-github';
import { api, scoped, signup, usePlatformFixture } from './repo-fixture';

usePlatformFixture();

let hub: FakeGitHub;
let env: Env;
const ORIGIN = 'https://yoneda';
const repo = (id: number, name: string, hidden = true) => ({ id, full_name: name, private: hidden });

beforeAll(async () => {
  hub = await new FakeGitHub().keys();
});

function serve() {
  hub.installations.clear();
  hub.minted = [];
  hub.asked = [];
  env = hub.env(scoped);
  serveAgain();
}

function serveAgain() {
  const original = globalThis.fetch;
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = String(input instanceof Request ? input.url : input);
    return (await hub.handle(url, init)) ?? original(input, init);
  });
}
afterEach(() => vi.restoreAllMocks());

const visit = (path: string, cookie?: string, target = env) =>
  platformFetch(new Request(`${ORIGIN}/api/v1${path}`, { headers: cookie ? { cookie } : {} }), target);

/** Connect, as far as GitHub's install page: what GitHub would carry back and what the browser
 * keeps. The session cookie is SameSite=Strict, so it does not make the trip home. */
async function leave(cookie: string) {
  const going = await visit('/github/connect', cookie);
  expect(going.status).toBe(302);
  const to = new URL(going.headers.get('location') as string);
  expect(`${to.origin}${to.pathname}`).toBe('https://github.com/apps/test-import/installations/new');
  const bound = going.headers.get('set-cookie') as string;
  expect(bound).toMatch(/SameSite=Lax/);
  return { state: to.searchParams.get('state') as string, binding: bound.split(';')[0] };
}
type Trip = Awaited<ReturnType<typeof leave>>;

const home = (id: number | string, trip: Pick<Trip, 'state'>, action = 'install') =>
  `/github/connected?installation_id=${id}&setup_action=${action}&state=${encodeURIComponent(trip.state)}`;
const arrive = (id: number | string, trip: Trip) => visit(home(id, trip), trip.binding);

async function person(name: string, subject: number, login: string) {
  const cookie = await signup(name);
  const account = await linkGitHub(env, cookie, subject, login);
  return { cookie, account };
}

const repositories = (cookie: string, target = env) => api('/github/repositories', { cookie }, {}, target);

describe('the key', () => {
  it('reads as GitHub hands it over, and as it is when wrapped already', async () => {
    serve();
    const signing = { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' };
    const wrapped = pkcs8Of(hub.key);
    await expect(crypto.subtle.importKey('pkcs8', wrapped, signing, false, ['sign'])).resolves.toBeDefined();
    const pem = `-----BEGIN PRIVATE KEY-----\n${btoa(String.fromCharCode(...wrapped))}\n-----END PRIVATE KEY-----`;
    expect(pkcs8Of(pem)).toEqual(wrapped);
    expect(pkcs8Of(hub.key.replaceAll('\n', '\\n'))).toEqual(wrapped);
  });
});

describe('connecting', () => {
  it('ends with the installation on the account, and no token anywhere', async () => {
    serve();
    const { cookie, account } = await person('gh_ada', 101, 'ada');
    const trip = await leave(cookie);
    hub.install(9001, 101, 'ada', [repo(1, 'ada/secret')]);

    const done = await arrive(9001, trip);

    expect(done.status).toBe(302);
    expect(done.headers.get('location')).toBe(`${ORIGIN}/settings?github=connected`);
    expect(done.headers.get('set-cookie')).toMatch(/Max-Age=0/);
    const held = await workspace(env, account, { op: 'github_installation_get' });
    expect(held).toMatchObject({ installation: 9001, login: 'ada' });
    expect(Object.keys(held).sort()).toEqual([
      'connected_at',
      'connected_by',
      'installation',
      'login',
      'target_id',
      'target_type',
    ]);
  });

  it('refuses a forged installation_id: someone else’s installation reaches no one', async () => {
    serve();
    const { cookie, account } = await person('gh_eve', 102, 'eve');
    hub.install(9002, 999, 'victim', [repo(2, 'victim/payroll')]);

    const done = await arrive(9002, await leave(cookie));

    expect(done.headers.get('location')).toContain('github=other_account');
    expect(await workspace(env, account, { op: 'github_installation_get' })).toEqual({});
    expect((await repositories(cookie)).body).toMatchObject({ connection: 'none' });
    expect(hub.minted).toEqual([]);
  });

  it('refuses an id GitHub does not know', async () => {
    serve();
    const { cookie, account } = await person('gh_nobody', 103, 'nobody');

    const done = await arrive(424242, await leave(cookie));

    expect(done.headers.get('location')).toContain('github=other_account');
    expect(await workspace(env, account, { op: 'github_installation_get' })).toEqual({});
  });

  it('takes no return without a state signed for this browser, in time', async () => {
    serve();
    const { cookie, account } = await person('gh_state', 105, 'statey');
    const other = await person('gh_state2', 106, 'other');
    const mine = await leave(cookie);
    const theirs = await leave(other.cookie);
    hub.install(9005, 105, 'statey');

    const tries = [
      { state: '', binding: mine.binding },
      { state: 'garbage', binding: mine.binding },
      { state: `${mine.state}0`, binding: mine.binding },
      // Another account's state in this browser, and this state with no browser behind it.
      { state: theirs.state, binding: mine.binding },
      { state: mine.state, binding: theirs.binding },
      { state: mine.state, binding: 'yoneda_github=' },
    ];
    for (const trip of tries)
      expect((await arrive(9005, trip)).headers.get('location')).toContain('github=state');
    expect((await visit(home(9005, mine))).headers.get('location')).toContain('github=state');
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 31 * 60_000);
    expect((await arrive(9005, mine)).headers.get('location')).toContain('github=state');
    vi.restoreAllMocks();
    serveAgain();
    expect(await workspace(env, account, { op: 'github_installation_get' })).toEqual({});
  });

  it('needs no session on the way back, as the cookie does not cross from GitHub', async () => {
    serve();
    const { cookie, account } = await person('gh_strict', 115, 'strict');
    const trip = await leave(cookie);
    hub.install(9015, 115, 'strict');

    const done = await visit(home(9015, trip), trip.binding);

    expect(done.headers.get('location')).toContain('github=connected');
    expect(await workspace(env, account, { op: 'github_installation_get' })).toMatchObject({ installation: 9015 });
  });

  it('takes an owner’s pending approval for what it is', async () => {
    serve();
    const { cookie } = await person('gh_request', 107, 'req');
    const trip = await leave(cookie);

    const done = await visit(`/github/connected?setup_action=request&state=${encodeURIComponent(trip.state)}`, trip.binding);

    expect(done.headers.get('location')).toContain('github=requested');
  });

  it('sends someone with no linked GitHub to the link step first', async () => {
    serve();
    const cookie = await signup('gh_unlinked');

    const going = await visit('/github/connect', cookie);

    expect(going.status).toBe(302);
    expect(going.headers.get('location')).toBe(`${ORIGIN}/auth/github/start?intent=link`);
    expect(hub.asked).toEqual([]);
  });

  it('sends someone signed out to sign in', async () => {
    serve();
    expect((await visit('/github/connect')).headers.get('location')).toBe(`${ORIGIN}/signin`);
  });

  it('finds an installation already there, as GitHub sends no one back from its settings', async () => {
    serve();
    const { cookie, account } = await person('gh_already', 108, 'already');
    hub.install(9008, 108, 'already');

    const going = await visit('/github/connect', cookie);

    expect(going.headers.get('location')).toBe(`${ORIGIN}/settings?github=connected`);
    expect(await workspace(env, account, { op: 'github_installation_get' })).toMatchObject({ installation: 9008 });
  });

  it('comes back to a page saying so when GitHub fails', async () => {
    serve();
    const { cookie } = await person('gh_down', 109, 'down');
    const trip = await leave(cookie);
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response('', { status: 503 }));

    expect((await arrive(9009, trip)).headers.get('location')).toContain('github=unavailable');
  });

  it('is not there at all without the App', async () => {
    serve();
    const cookie = await signup('gh_off');

    expect((await visit('/github/connect', cookie, scoped)).status).toBe(404);
    expect((await repositories(cookie, scoped)).body).toEqual({ available: false });
  });

  it('is reached on the App’s setup URL through the front Worker', async () => {
    serve();
    const { cookie } = await person('gh_front', 110, 'front');
    const trip = await leave(cookie);
    hub.install(9010, 110, 'front');
    const PLATFORM = { fetch: (req: Request) => platformFetch(req, env) } as unknown as Fetcher;

    const done = await frontFetch(
      new Request(`${ORIGIN}${home(9010, trip)}`, { headers: { cookie: trip.binding } }),
      { ...env, PLATFORM } as Env,
    );

    expect(done.headers.get('location')).toBe(`${ORIGIN}/settings?github=connected`);
  });
});

describe('the repositories shown', () => {
  it('asks for one Connect from someone with no installation', async () => {
    serve();
    const { cookie } = await person('gh_none', 111, 'none');

    const seen = await repositories(cookie);

    expect(seen.body).toEqual({ available: true, connection: 'none' });
    expect(hub.asked).toEqual([]);
  });

  it('lists every page GitHub has, ids and names only', async () => {
    serve();
    const { cookie } = await person('gh_list', 112, 'lister');
    const all = Array.from({ length: 130 }, (_, i) => ({ ...repo(1000 + i, `lister/r${i}`), owner: { login: 'lister' } }));
    hub.install(9012, 112, 'lister', all);
    await visit('/github/connect', cookie);

    const seen = await repositories(cookie);

    expect(seen.body.connection).toBe('ok');
    expect(seen.body.login).toBe('lister');
    expect(seen.body.more).toBe(false);
    expect(seen.body.repositories).toHaveLength(130);
    expect(seen.body.repositories[129]).toEqual({ ...repo(1129, 'lister/r129'), installation: 9012 });
    expect(JSON.stringify(seen.body)).not.toContain('ghs_');
  });

  it('says the connection is lost when the installation is removed, suspended, or the link undone', async () => {
    serve();
    const { cookie, account } = await person('gh_lost', 113, 'loser');
    const installed = hub.install(9013, 113, 'loser', [repo(5, 'loser/app')]);
    await visit('/github/connect', cookie);

    installed.suspended_at = '2026-11-01T00:00:00Z';
    expect((await repositories(cookie)).body).toEqual({ available: true, connection: 'lost' });
    installed.suspended_at = null;
    hub.installations.delete(9013);
    expect((await repositories(cookie)).body).toEqual({ available: true, connection: 'lost' });
    hub.install(9013, 200, 'someone-else', [repo(5, 'loser/app')]);
    expect((await repositories(cookie)).body).toEqual({ available: true, connection: 'lost' });
    expect(hub.minted).toEqual([]);

    hub.install(9113, 113, 'loser', [repo(5, 'loser/app')]);
    await visit('/github/connect', cookie);
    expect(await workspace(env, account, { op: 'github_installation_get' })).toMatchObject({ installation: 9113 });
    expect((await repositories(cookie)).body.connection).toBe('ok');
  });

  it('is a person’s, not an API token’s', async () => {
    serve();
    const { cookie } = await person('gh_token', 114, 'tok');
    const pat = await api('/tokens', { cookie }, { body: { name: 'x', scopes: ['repo:read'] } }, env);

    const seen = await api('/github/repositories', { token: pat.body.token }, {}, env);

    expect(seen.status).toBe(403);
  });
});

describe('importing a picked repository', () => {
  const workflows = () => {
    const created: any[] = [];
    return { created, create: async (o: any) => (created.push(o), { id: o.id }), get: async () => ({ status: async () => ({ status: 'running' }) }) };
  };

  async function connected(name: string, subject: number, repositories: any[]) {
    const { cookie } = await person(name, subject, name.replace('_', '-'));
    hub.install(subject * 10, subject, name.replace('_', '-'), repositories);
    await visit('/github/connect', cookie);
    return cookie;
  }

  it('takes GitHub’s word for what it is, and a private source stays private', async () => {
    serve();
    const cookie = await connected('gh_imp', 120, [repo(77, 'gh-imp/secret')]);
    const PLATFORM_IMPORT = workflows();
    const target = { ...env, PLATFORM_IMPORT } as unknown as Env;

    const made = await api('/repos/import', { cookie }, { body: { github_repository: 77, name: 'secret', visibility: 'public', url: 'https://github.com/acme/wrong' } }, target);

    expect(made.status).toBe(200);
    expect(hub.minted[hub.minted.length - 1].scope).toEqual({ repository_ids: [77], permissions: { contents: 'read' } });
    expect((await api(`/repos/${made.body.id}`, { cookie }, {}, target)).body.visibility).toBe('private');
    expect(PLATFORM_IMPORT.created[0].params).toMatchObject({ url: 'https://github.com/gh-imp/secret.git', github: { installation: 1200, repository: 77 } });
  });

  it('keeps a public source’s visibility as asked', async () => {
    serve();
    const cookie = await connected('gh_pub', 121, [repo(78, 'gh-pub/open', false)]);
    const target = { ...env, PLATFORM_IMPORT: workflows() } as unknown as Env;

    const made = await api('/repos/import', { cookie }, { body: { github_repository: 78, name: 'open', visibility: 'public' } }, target);

    expect((await api(`/repos/${made.body.id}`, { cookie }, {}, target)).body.visibility).toBe('public');
  });

  it('keeps the token out of the answer, the payload and what is stored', async () => {
    serve();
    const cookie = await connected('gh_clean', 122, [repo(79, 'gh-clean/a')]);
    const PLATFORM_IMPORT = workflows();
    const target = { ...env, PLATFORM_IMPORT } as unknown as Env;

    const made = await api('/repos/import', { cookie }, { body: { github_repository: 79, name: 'a' } }, target);

    const kept = await (await env.OBJECTS.get(`platform/v1/${made.body.id}/import-asked.json`))?.text();
    const token = hub.minted[hub.minted.length - 1].token;
    for (const said of [JSON.stringify(made.body), JSON.stringify(PLATFORM_IMPORT.created), kept]) expect(said).not.toContain(token);
  });

  it('refuses a repository outside the installation, by mistake or on purpose', async () => {
    serve();
    const cookie = await connected('gh_out', 123, [repo(80, 'gh-out/a')]);
    hub.install(5555, 999, 'victim', [repo(81, 'victim/payroll')]);
    const PLATFORM_IMPORT = workflows();
    const target = { ...env, PLATFORM_IMPORT } as unknown as Env;

    const made = await api('/repos/import', { cookie }, { body: { github_repository: 81, name: 'stolen' } }, target);

    expect(made.status).not.toBe(200);
    expect(made.body.error.code).toBe('GITHUB_NOT_CONNECTED');
    expect(PLATFORM_IMPORT.created).toEqual([]);
  });

  it('stops a private address before there is a repository, and sends the person to connect', async () => {
    serve();
    const { cookie } = await person('gh_paste', 126, 'paste');
    const PLATFORM_IMPORT = workflows();
    const target = { ...env, PLATFORM_IMPORT } as unknown as Env;
    const remote = 'https://github.com/someone/secret.git';
    const original = globalThis.fetch;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.startsWith(remote)) return new Response('', { status: 401 });
      return original(input, init);
    });

    const made = await api('/repos/import', { cookie }, { body: { url: remote, name: 'secret' } }, target);

    expect(made.body.error.code).toBe('GITHUB_NOT_CONNECTED');
    expect(PLATFORM_IMPORT.created).toEqual([]);
    const listed = await api('/repos', { cookie }, {}, target);
    expect(listed.body.repos.map((r: { name: string }) => r.name)).not.toContain('secret');
  });

  it('refuses without a connection, a removed one, and an API token', async () => {
    serve();
    const { cookie } = await person('gh_noconn', 124, 'noconn');
    const target = { ...env, PLATFORM_IMPORT: workflows() } as unknown as Env;
    const none = await api('/repos/import', { cookie }, { body: { github_repository: 1, name: 'x' } }, target);
    expect(none.body.error.code).toBe('GITHUB_NOT_CONNECTED');

    const removed = await connected('gh_gone', 125, [repo(82, 'gh-gone/a')]);
    hub.installations.delete(1250);
    const lost = await api('/repos/import', { cookie: removed }, { body: { github_repository: 82, name: 'x' } }, target);
    expect(lost.body.error.code).toBe('GITHUB_NOT_CONNECTED');

    const pat = await api('/tokens', { cookie }, { body: { name: 'x', scopes: ['repo:admin'] } }, env);
    const token = await api('/repos/import', { token: pat.body.token }, { body: { github_repository: 1, name: 'x' } }, target);
    expect(token.status).toBe(403);
  });
});
