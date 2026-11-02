// Connecting a GitHub organization, against a fake GitHub. An `installation_id` is anyone's to
// write, so the case that matters is a forged one: an organization the person has nothing to do
// with. Only an active owner connects one, proved by a token used once and kept nowhere.
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { frontFetch } from '../../cloudflare/worker/front-routes';
import { platformFetch } from '../../cloudflare/worker/platform-routes';
import type { Env } from '../../cloudflare/worker/types';
import { workspace } from '../../cloudflare/worker/workspace';
import { FakeGitHub, linkGitHub, type Repo } from './fake-github';
import { api, scoped, signup, usePlatformFixture } from './repo-fixture';

usePlatformFixture();

const ORIGIN = 'https://yoneda';
let hub: FakeGitHub;
let env: Env;
let front: Env;

beforeAll(async () => {
  hub = await new FakeGitHub().keys();
});
afterEach(() => vi.restoreAllMocks());

function serve() {
  hub.installations.clear();
  hub.memberships.clear();
  hub.minted = [];
  hub.asked = [];
  hub.tokens = [];
  env = hub.env(scoped);
  front = {
    ...env,
    PLATFORM: { fetch: (req: Request) => platformFetch(req, env) } as unknown as Fetcher,
    GITHUB_OAUTH_CLIENT_ID: 'gh-client',
    GITHUB_OAUTH_CLIENT_SECRET: 'gh-secret',
    PUBLIC_APP_ORIGIN: ORIGIN,
  } as Env;
  const original = globalThis.fetch;
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = String(input instanceof Request ? input.url : input);
    return (await hub.handle(url, init)) ?? original(input, init);
  });
}

const repo = (id: number, name: string): Repo => ({ id, full_name: name, private: true });
const browse = (path: string, cookie?: string) =>
  frontFetch(new Request(`${ORIGIN}${path}`, { headers: cookie ? { cookie } : {} }), front);
const held = (account: string) => workspace(env, account, { op: 'github_installation_list' });
const noneHeld = async (account: string) =>
  expect((await held(account)).installations).toEqual([]);

async function person(name: string, subject: number, login: string) {
  const cookie = await signup(name);
  hub.person = { id: subject, login };
  return { cookie, account: await linkGitHub(env, cookie, subject, login) };
}

/** Out to GitHub's install page and back to the setup URL: what the browser is sent to next. */
async function installed(cookie: string, id: number, action = 'install') {
  const going = await platformFetch(
    new Request(`${ORIGIN}/api/v1/github/connect?add=1`, { headers: { cookie } }),
    env,
  );
  const to = new URL(going.headers.get('location') as string);
  const state = to.searchParams.get('state') as string;
  const binding = (going.headers.get('set-cookie') as string).split(';')[0];
  const query = `installation_id=${id}&setup_action=${action}&state=${encodeURIComponent(state)}`;
  const back = await browse(`/github/connected?${query}`, binding);
  return back.headers.get('location') as string;
}

/** The sign-in round that proves an owner, from the page that starts it to where it ends. */
async function proved(next: string, query: (state: string) => string = (s) => `code=c&state=${s}`) {
  const going = await browse(next.replace(ORIGIN, ''));
  const to = new URL(going.headers.get('location') as string);
  const binding = (going.headers.get('set-cookie') as string).split(';')[0];
  const state = to.searchParams.get('state') as string;
  const done = await browse(`/auth/github/callback?${query(state)}`, binding);
  return { to, location: done.headers.get('location') as string };
}

const connect = async (cookie: string, id: number) => proved(await installed(cookie, id));

describe('an organization', () => {
  it('connects for an active owner, through the existing sign-in with read:org', async () => {
    serve();
    const { cookie, account } = await person('gh_owner', 201, 'owner');
    hub.install(7001, 900, 'acme', [repo(1, 'acme/app')], 'Organization');
    hub.memberships.set('owner:acme', { state: 'active', role: 'admin' });

    const next = await installed(cookie, 7001);
    expect(next).toMatch(/^https:\/\/yoneda\/auth\/github\/start\?intent=github_org&ticket=/);
    const { to, location } = await proved(next);

    expect(`${to.origin}${to.pathname}`).toBe('https://github.com/login/oauth/authorize');
    expect(to.searchParams.get('client_id')).toBe('gh-client');
    expect(to.searchParams.get('scope')?.split(' ')).toContain('read:org');
    expect(location).toBe(`${ORIGIN}/settings?github=connected`);
    expect((await held(account)).installations).toMatchObject([
      {
        installation: 7001,
        login: 'acme',
        target_type: 'Organization',
        target_id: 900,
        connected_by: '201',
      },
    ]);
  });

  it('keeps no token: it is used once and nothing stored holds it', async () => {
    serve();
    const { cookie, account } = await person('gh_token', 202, 'tokens');
    hub.install(7002, 901, 'acme', [], 'Organization');
    hub.memberships.set('tokens:acme', { state: 'active', role: 'admin' });

    await connect(cookie, 7002);

    expect(hub.tokens).toHaveLength(1);
    expect(hub.asked.filter((a) => a.startsWith('GET /user/memberships/'))).toEqual([
      'GET /user/memberships/orgs/acme',
    ]);
    const kept = JSON.stringify(await held(account));
    expect(kept).not.toContain(hub.tokens[0]);
    // A sign-in afterwards asks for no more than it did.
    const signin = await browse('/auth/github/start');
    const scope = new URL(signin.headers.get('location') as string).searchParams.get('scope');
    expect(scope).not.toContain('read:org');
  });

  it('refuses a forged installation_id from someone who is no member', async () => {
    serve();
    const { cookie, account } = await person('gh_eve_org', 203, 'eve_org');
    hub.install(7003, 902, 'victim-corp', [repo(2, 'victim-corp/payroll')], 'Organization');

    const { location } = await connect(cookie, 7003);

    expect(location).toBe(`${ORIGIN}/settings?github=not_member`);
    await noneHeld(account);
    const seen = await api('/github/repositories', { cookie }, {}, env);
    expect(seen.body).toMatchObject({ connection: 'none' });
    expect(hub.minted).toEqual([]);
  });

  it.each([
    ['a member', { state: 'active', role: 'member' }],
    ['a billing manager', { state: 'active', role: 'billing_manager' }],
    ['an invited owner', { state: 'pending', role: 'admin' }],
  ])('refuses %s: only an active owner connects', async (_who, membership) => {
    serve();
    const { cookie, account } = await person('gh_member', 204, 'member');
    hub.install(7004, 903, 'acme', [], 'Organization');
    hub.memberships.set('member:acme', membership);

    const { location } = await connect(cookie, 7004);

    expect(location).toBe(`${ORIGIN}/settings?github=org_owner`);
    await noneHeld(account);
  });

  it('says so when the organization blocks the check', async () => {
    serve();
    const { cookie, account } = await person('gh_block', 205, 'blocked');
    hub.install(7005, 904, 'acme', [], 'Organization');
    hub.memberships.set('blocked:acme', 'blocked');

    const { location } = await connect(cookie, 7005);

    expect(location).toBe(`${ORIGIN}/settings?github=org_blocked`);
    await noneHeld(account);
  });

  it('refuses a GitHub user other than the one this account linked', async () => {
    serve();
    const { cookie, account } = await person('gh_swap', 206, 'swap');
    hub.install(7006, 905, 'acme', [], 'Organization');
    hub.memberships.set('someone_else:acme', { state: 'active', role: 'admin' });
    const next = await installed(cookie, 7006);

    hub.person = { id: 999, login: 'someone_else' };
    const { location } = await proved(next);

    expect(location).toBe(`${ORIGIN}/settings?github=other_account`);
    await noneHeld(account);
  });

  it('says so when the person turns GitHub down', async () => {
    serve();
    const { cookie, account } = await person('gh_denied', 207, 'denied');
    hub.install(7007, 906, 'acme', [], 'Organization');

    const { location } = await proved(
      await installed(cookie, 7007),
      (state) => `error=access_denied&state=${state}`,
    );

    expect(location).toBe(`${ORIGIN}/settings?github=org_denied`);
    await noneHeld(account);
  });

  it('takes a ticket once, and no ticket it did not issue', async () => {
    serve();
    const { cookie, account } = await person('gh_ticket', 208, 'ticket');
    hub.install(7008, 907, 'acme', [], 'Organization');
    hub.memberships.set('ticket:acme', { state: 'active', role: 'admin' });
    const next = await installed(cookie, 7008);

    const bad = next.replace(/.{8}$/, '00000000');
    const guessed = await browse(bad.replace(ORIGIN, ''));
    expect(guessed.headers.get('location')).toContain('/settings');
    expect(guessed.headers.get('location')).toContain('auth_error=state');
    await noneHeld(account);

    await proved(next);
    expect((await held(account)).installations).toHaveLength(1);
    const again = await browse(next.replace(ORIGIN, ''));
    expect(again.headers.get('location')).toContain('auth_error=state');
  });

  it('asks for no sign-in round for a suspended installation', async () => {
    serve();
    const { cookie } = await person('gh_paused', 209, 'paused');
    const installation = hub.install(7009, 908, 'acme', [], 'Organization');
    (installation as any).suspended_at = '2026-01-01T00:00:00Z';

    expect(await installed(cookie, 7009)).toBe(`${ORIGIN}/settings?github=lost`);
  });
});

describe('an installation waiting on an owner', () => {
  it('says GitHub asked an owner to approve, with no id and no sign-in round', async () => {
    serve();
    const { cookie, account } = await person('gh_asked', 210, 'asked');
    const going = await platformFetch(
      new Request(`${ORIGIN}/api/v1/github/connect?add=1`, { headers: { cookie } }),
      env,
    );
    const state = new URL(going.headers.get('location') as string).searchParams.get('state');
    const binding = (going.headers.get('set-cookie') as string).split(';')[0];

    const back = await browse(
      `/github/connected?setup_action=request&state=${encodeURIComponent(state as string)}`,
      binding,
    );

    expect(back.headers.get('location')).toBe(`${ORIGIN}/settings?github=requested`);
    expect(hub.asked).toEqual([]);
    await noneHeld(account);
  });
});

describe('several installations', () => {
  async function three() {
    serve();
    const { cookie, account } = await person('gh_many', 211, 'many');
    hub.install(7100, 211, 'many', [repo(10, 'many/own')]);
    hub.install(7101, 910, 'acme', [repo(11, 'acme/app')], 'Organization');
    hub.install(7102, 911, 'globex', [repo(12, 'globex/site')], 'Organization');
    hub.memberships.set('many:acme', { state: 'active', role: 'admin' });
    hub.memberships.set('many:globex', { state: 'active', role: 'admin' });
    await installed(cookie, 7100);
    await connect(cookie, 7101);
    await connect(cookie, 7102);
    return { cookie, account };
  }
  const shown = (cookie: string, query = '') =>
    api(`/github/repositories${query}`, { cookie }, {}, env);

  it('offers each one, its own first, and shows the one asked for', async () => {
    const { cookie } = await three();
    const first = (await shown(cookie)).body;
    expect(first.installations).toEqual([
      { id: 7100, login: 'many', type: 'User' },
      { id: 7101, login: 'acme', type: 'Organization' },
      { id: 7102, login: 'globex', type: 'Organization' },
    ]);
    expect(first).toMatchObject({ connection: 'ok', login: 'many', installation: 7100 });
    expect(first.repositories.map((r: Repo) => r.full_name)).toEqual(['many/own']);
    const org = (await shown(cookie, '?installation=7102')).body;
    expect(org).toMatchObject({ login: 'globex', installation: 7102 });
    expect(org.repositories.map((r: Repo) => r.full_name)).toEqual(['globex/site']);
  });

  it('names GitHub’s own page for the installation shown', async () => {
    const { cookie } = await three();
    const own = (await shown(cookie)).body;
    expect(own.manage_url).toBe('https://github.com/settings/installations/7100');
    const org = (await shown(cookie, '?installation=7102')).body;
    expect(org.manage_url).toBe('https://github.com/organizations/globex/settings/installations/7102');
  });

  it('builds that page when GitHub leaves it out, and never links elsewhere', async () => {
    const { cookie } = await three();
    const installed = hub.installations.get(7101) as any;
    installed.html_url = undefined;
    const missing = (await shown(cookie, '?installation=7101')).body;
    expect(missing.manage_url).toBe('https://github.com/organizations/acme/settings/installations/7101');
    installed.html_url = 'https://evil.example/settings/installations/7101';
    const elsewhere = (await shown(cookie, '?installation=7101')).body;
    expect(elsewhere.manage_url).toBe('https://github.com/organizations/acme/settings/installations/7101');
    (hub.installations.get(7100) as any).html_url = undefined;
    expect((await shown(cookie)).body.manage_url).toBe('https://github.com/settings/installations/7100');
  });

  it('still names the page when the installation has no repositories', async () => {
    serve();
    const { cookie } = await person('gh_empty', 213, 'empty');
    hub.install(7300, 213, 'empty', []);
    await installed(cookie, 7300);
    const body = (await shown(cookie)).body;
    expect(body.repositories).toEqual([]);
    expect(body.manage_url).toBe('https://github.com/settings/installations/7300');
  });

  it('shows nothing of an installation this account did not connect', async () => {
    const { cookie } = await three();
    hub.install(7199, 912, 'victim-corp', [repo(13, 'victim-corp/payroll')], 'Organization');
    const before = hub.minted.length;

    const seen = (await shown(cookie, '?installation=7199')).body;

    expect(seen).toMatchObject({ connection: 'none' });
    expect(seen.repositories).toBeUndefined();
    expect(hub.minted.length).toBe(before);
  });

  it('re-checks an organization by reading it: gone, suspended or moved is lost', async () => {
    const { cookie } = await three();
    const installation = hub.installations.get(7101) as any;
    installation.suspended_at = '2026-01-01T00:00:00Z';
    expect((await shown(cookie)).body.installations.map((i: any) => i.id)).toEqual([7100, 7102]);
    installation.suspended_at = null;
    installation.account.id = 999;
    expect((await shown(cookie)).body.installations.map((i: any) => i.id)).toEqual([7100, 7102]);
    installation.account.id = 910;
    hub.installations.delete(7102);
    expect((await shown(cookie)).body.installations.map((i: any) => i.id)).toEqual([7100, 7101]);
    expect((await shown(cookie, '?installation=7102')).body).toMatchObject({ connection: 'lost' });
  });

  it('stops using an organization once the person unlinks the GitHub that connected it', async () => {
    const { cookie, account } = await three();
    await workspace(env, account, { op: 'identity_unlink', provider: 'github' }).catch(() => {});
    const body = (await shown(cookie)).body;
    expect(body.installations ?? []).toEqual([]);
  });

  it('imports from the organization asked for, and from no other', async () => {
    const { cookie } = await three();
    const created: any[] = [];
    const PLATFORM_IMPORT = {
      create: async (o: any) => (created.push(o), { id: o.id }),
      get: async () => ({ status: async () => ({ status: 'running' }) }),
    };
    const target = { ...env, PLATFORM_IMPORT } as unknown as Env;
    const ask = (github_repository: number, github_installation: number, name: string) =>
      api(
        '/repos/import',
        { cookie },
        { body: { github_repository, github_installation, name, visibility: 'private' } },
        target,
      );

    const made = await ask(12, 7102, 'site');
    expect(made.status).toBe(200);
    expect(created[0].params).toMatchObject({ github: { installation: 7102, repository: 12 } });

    // A repository of another installation, and an installation this account never connected.
    expect((await ask(12, 7101, 'elsewhere')).status).toBeGreaterThanOrEqual(400);
    hub.install(7199, 912, 'victim-corp', [repo(13, 'victim-corp/payroll')], 'Organization');
    const minted = hub.minted.length;
    const foreign = await ask(13, 7199, 'payroll');
    expect(foreign.body.error?.code).toBe('GITHUB_NOT_CONNECTED');
    expect(hub.minted.length).toBe(minted);
    expect(created).toHaveLength(1);
  });

  it('adds an organization past an installation already there', async () => {
    serve();
    const { cookie } = await person('gh_add', 212, 'adder');
    hub.install(7200, 212, 'adder');
    const direct = await platformFetch(
      new Request(`${ORIGIN}/api/v1/github/connect`, { headers: { cookie } }),
      env,
    );
    expect(direct.headers.get('location')).toBe(`${ORIGIN}/settings?github=connected`);
    const adding = await platformFetch(
      new Request(`${ORIGIN}/api/v1/github/connect?add=1`, { headers: { cookie } }),
      env,
    );
    expect(adding.headers.get('location')).toContain('github.com/apps/test-import/installations/new');
  });

  it('leaves an organization’s installation on GitHub when the account closes', async () => {
    const { account } = await three();
    await workspace(env, account, { op: 'github_installation_list' });
    const { heldToUninstall } = await import('../../cloudflare/worker/platform-account-close');
    expect(await heldToUninstall(env, account)).toBe(7100);
    hub.installations.delete(7100);
    expect(await heldToUninstall(env, account)).toBeNull();
  });
});
