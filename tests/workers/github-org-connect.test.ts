// Connecting a GitHub organization, against a fake GitHub. An `installation_id` is anyone's to
// write, so the case that matters is a forged one: an organization the person has nothing to do
// with. Anyone GitHub counts on one of its repositories connects, and sees only what they reach.
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
  hub.collaborators.clear();
  hub.logins.clear();
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
  hub.logins.set(login, subject);
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

const connect = installed;
const shown = (cookie: string) => api('/github/repositories', { cookie }, {}, env);

describe('an organization', () => {
  it('connects for anyone on one of its repositories, with no sign-in round', async () => {
    serve();
    const { cookie, account } = await person('gh_owner', 201, 'owner');
    hub.install(7001, 900, 'acme', [repo(1, 'acme/app')], 'Organization');
    hub.collaborators.add('acme/app:owner');

    expect(await installed(cookie, 7001)).toBe(`${ORIGIN}/settings?github=connected`);

    expect(hub.tokens).toEqual([]);
    expect(hub.asked.some((a) => a.includes('/user/memberships'))).toBe(false);
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

  it('refuses a forged installation_id from someone on none of its repositories', async () => {
    serve();
    const { cookie, account } = await person('gh_eve_org', 203, 'eve_org');
    hub.install(7003, 902, 'victim-corp', [repo(2, 'victim-corp/payroll')], 'Organization');

    expect(await connect(cookie, 7003)).toBe(`${ORIGIN}/settings?github=not_member`);

    await noneHeld(account);
    expect((await shown(cookie)).body).toMatchObject({ connection: 'none' });
  });

  it('refuses an organization with nothing shared: there is nothing to prove access by', async () => {
    serve();
    const { cookie, account } = await person('gh_none', 204, 'none');
    hub.install(7004, 903, 'acme', [], 'Organization');

    expect(await connect(cookie, 7004)).toBe(`${ORIGIN}/settings?github=not_member`);
    await noneHeld(account);
  });

  it('refuses when the login now names a different GitHub user', async () => {
    serve();
    const { cookie, account } = await person('gh_swap', 206, 'swap');
    hub.install(7006, 905, 'acme', [repo(3, 'acme/app')], 'Organization');
    hub.collaborators.add('acme/app:swap');
    hub.logins.set('swap', 999);

    expect(await connect(cookie, 7006)).toBe(`${ORIGIN}/settings?github=other_account`);
    await noneHeld(account);
  });

  it('asks nothing of a suspended installation', async () => {
    serve();
    const { cookie } = await person('gh_paused', 209, 'paused');
    const installation = hub.install(7009, 908, 'acme', [], 'Organization');
    (installation as any).suspended_at = '2026-01-01T00:00:00Z';

    expect(await installed(cookie, 7009)).toBe(`${ORIGIN}/settings?github=lost`);
  });

  it('shows a private repository only to those it counts, and a public one to all', async () => {
    serve();
    const { cookie } = await person('gh_list', 214, 'lister');
    const open = { id: 21, full_name: 'acme/open', private: false };
    const mine = repo(22, 'acme/mine');
    const theirs = repo(23, 'acme/theirs');
    hub.install(7010, 913, 'acme', [open, mine, theirs], 'Organization');
    hub.collaborators.add('acme/mine:lister');
    await connect(cookie, 7010);

    const names = (await shown(cookie)).body.repositories.map((r: Repo) => r.full_name);

    expect(names).toEqual(['acme/open', 'acme/mine']);
  });
});

describe('someone GitHub stops at asking an owner', () => {
  const asking = async (cookie: string) => {
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
    return back.headers.get('location');
  };

  it('says GitHub asked an owner, when no organization holding the App is theirs', async () => {
    serve();
    const { cookie, account } = await person('gh_asked', 210, 'asked');
    hub.install(7011, 914, 'victim-corp', [repo(4, 'victim-corp/payroll')], 'Organization');

    expect(await asking(cookie)).toBe(`${ORIGIN}/settings?github=requested`);
    await noneHeld(account);
  });

  it('connects an organization that already holds the App and that they can reach', async () => {
    serve();
    const { cookie, account } = await person('gh_member', 215, 'member');
    hub.install(7012, 915, 'acme', [repo(5, 'acme/app')], 'Organization');
    hub.collaborators.add('acme/app:member');

    expect(await asking(cookie)).toBe(`${ORIGIN}/settings?github=connected`);
    expect((await held(account)).installations).toMatchObject([{ installation: 7012 }]);
  });
});

describe('several installations', () => {
  async function three() {
    serve();
    const { cookie, account } = await person('gh_many', 211, 'many');
    hub.install(7100, 211, 'many', [repo(10, 'many/own')]);
    hub.install(7101, 910, 'acme', [repo(11, 'acme/app')], 'Organization');
    hub.install(7102, 911, 'globex', [repo(12, 'globex/site')], 'Organization');
    hub.collaborators.add('acme/app:many');
    hub.collaborators.add('globex/site:many');
    await installed(cookie, 7100);
    await connect(cookie, 7101);
    await connect(cookie, 7102);
    return { cookie, account };
  }

  it('lists every repository in one list, its own first, each with where it came from', async () => {
    const { cookie } = await three();
    const body = (await shown(cookie)).body;
    expect(body).toMatchObject({ connection: 'ok', login: 'many', installation: 7100 });
    expect(body.repositories.map((r: any) => [r.full_name, r.installation])).toEqual([
      ['many/own', 7100],
      ['acme/app', 7101],
      ['globex/site', 7102],
    ]);
  });

  it('leaves out an installation that went, and keeps the others', async () => {
    const { cookie } = await three();
    (hub.installations.get(7102) as any).suspended_at = '2026-01-01T00:00:00Z';
    const names = (await shown(cookie)).body.repositories.map((r: Repo) => r.full_name);
    expect(names).toEqual(['many/own', 'acme/app']);
  });

  it('answers with an empty list when nothing is shared', async () => {
    serve();
    const { cookie } = await person('gh_empty', 213, 'empty');
    hub.install(7300, 213, 'empty', []);
    await installed(cookie, 7300);
    expect((await shown(cookie)).body.repositories).toEqual([]);
  });

  it('shows nothing of an installation this account did not connect', async () => {
    const { cookie } = await three();
    hub.install(7199, 912, 'victim-corp', [repo(13, 'victim-corp/payroll')], 'Organization');
    const names = (await shown(cookie)).body.repositories.map((r: Repo) => r.full_name);
    expect(names).not.toContain('victim-corp/payroll');
  });

  it('drops an organization that is gone, suspended or moved', async () => {
    const { cookie } = await three();
    const names = async () =>
      ((await shown(cookie)).body.repositories as Repo[]).map((r) => r.full_name);
    const installation = hub.installations.get(7101) as any;
    installation.suspended_at = '2026-01-01T00:00:00Z';
    expect(await names()).toEqual(['many/own', 'globex/site']);
    installation.suspended_at = null;
    installation.account.id = 999;
    expect(await names()).toEqual(['many/own', 'globex/site']);
    installation.account.id = 910;
    hub.installations.delete(7102);
    expect(await names()).toEqual(['many/own', 'acme/app']);
  });

  it('stops using an organization once the person unlinks the GitHub that connected it', async () => {
    const { cookie, account } = await three();
    await workspace(env, account, { op: 'identity_unlink', provider: 'github' }).catch(() => {});
    const { body } = await shown(cookie);
    expect(body.connection).toBe('lost');
    expect(body.repositories).toBeUndefined();
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

  it('refuses a private repository of an organization this person is not on', async () => {
    const { cookie } = await three();
    const target = {
      ...env,
      PLATFORM_IMPORT: {
        create: async (o: any) => ({ id: o.id }),
        get: async () => ({ status: async () => ({ status: 'running' }) }),
      },
    } as unknown as Env;
    hub.collaborators.delete('globex/site:many');
    const refused = await api(
      '/repos/import',
      { cookie },
      {
        body: {
          github_repository: 12,
          github_installation: 7102,
          name: 'site',
          visibility: 'private',
        },
      },
      target,
    );
    expect(refused.body.error?.code).toBe('FORBIDDEN');
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
