// Deleting an account, against real authorities and D1. What matters most is the end: the GitHub
// identity and the address are free straight away, and whoever takes the name next finds nothing
// of what it had. A run that dies part way is finished by running it again.
import { runInDurableObject } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { linkTo, signInWith } from '../../cloudflare/worker/oauth-identity';
import { closeAccount } from '../../cloudflare/worker/platform-account-close';
import { closeByOperator } from '../../cloudflare/worker/platform-account-close-route';
import { platformFetch } from '../../cloudflare/worker/platform-routes';
import { sha } from '../../cloudflare/worker/storage';
import type { Env } from '../../cloudflare/worker/types';
import { workspace } from '../../cloudflare/worker/workspace';
import { FakeGitHub, linkGitHub } from './fake-github';
import { api, author, bindings, failingOp, file, scoped, signup, usePlatformFixture } from './repo-fixture';

usePlatformFixture();

const env = { ...scoped, REPO_UNDO_DAYS: '30' } as unknown as Env;
const policy = { required_checks: [], approvals: 0 };
const identity = (subject: number, login: string, email: string) => ({
  provider: 'github' as const,
  subject: String(subject),
  login,
  email,
  avatar: null,
});

const sessionOf = (cookie: string) => {
  const value = decodeURIComponent(cookie.slice(cookie.indexOf('=') + 1));
  const at = value.lastIndexOf('.');
  return { account: value.slice(0, at), token: value.slice(at + 1) };
};

const closure = (cookie: string, body?: object, target: Env = env) =>
  platformFetch(
    new Request('https://yoneda/api/v1/account/closure', {
      method: body ? 'POST' : 'GET',
      headers: { cookie, 'content-type': 'application/json' },
      ...(body && { body: JSON.stringify(body) }),
    }),
    target,
  );

async function person(name: string) {
  const cookie = await signup(name);
  return { cookie, account: sessionOf(cookie).account, owner: { cookie } };
}

async function repoOf(owner: { cookie: string }, name: string) {
  const made = await api('/repos', owner, { body: { name, policy, files: [file('a.txt', 'one\n')], author } }, env);
  expect(made.status).toBe(200);
  return made.body.id as string;
}

const row = (account: string) =>
  env.INDEX.prepare('SELECT account FROM platform_accounts WHERE account=?').bind(account).first();
const exists = async (account: string) =>
  (await workspace(env, account, { op: 'account_exists' })).exists === true;

/** Kills a run at the first `op` sent to an account authority. */
function crashingAt(op: string, target: Env = env): Env {
  const real = target.WORKSPACES;
  const WORKSPACES = {
    idFromName: (name: string) => real.idFromName(name),
    get: (id: DurableObjectId) => ({
      fetch: (url: string, init: RequestInit) => {
        if (JSON.parse(String(init.body)).op === op) throw new Error('The Worker died');
        return real.get(id).fetch(url, init);
      },
    }),
  };
  return { ...target, WORKSPACES } as unknown as Env;
}

afterEach(() => vi.restoreAllMocks());

describe('deleting an account', () => {
  it('frees its GitHub identity, address and name at once, for a sign-up or a link', async () => {
    const { cookie, account, owner } = await person('close_ada');
    await linkGitHub(env, cookie, 7001, 'closeada');
    const github = identity(7001, 'closeada', 'close_ada@example.com');
    await env.WORKSPACES.get(env.WORKSPACES.idFromName(`identity:github:7001`)).fetch('http://workspace/command', {
      method: 'POST',
      body: JSON.stringify({ op: 'identity_claim', account, key: 'identity:github:7001', replace: true }),
    });
    await repoOf(owner, 'gone');

    const done = await closure(cookie, { confirm: account });

    expect(done.status).toBe(200);
    expect(done.headers.get('set-cookie')).toMatch(/Max-Age=0/);
    expect(await done.json()).toMatchObject({ closed: true, repos: 1 });
    expect(await exists(account)).toBe(false);
    expect(await row(account)).toBeNull();
    expect((await closure(cookie)).status).toBe(401);

    const again = await signup('close_ada');
    expect(sessionOf(again).account).toBe(account);
    const repos = await api('/repos', { cookie: again }, {}, env);
    expect(repos.body.repos).toEqual([]);

    const other = await person('close_other');
    const linked = await linkTo(env, github, other.account, await sha(sessionOf(other.cookie).token));
    expect(linked).toEqual({ kind: 'linked' });
  });

  it('lets the same GitHub account sign up afresh', async () => {
    const { cookie, account } = await person('close_gh');
    await linkGitHub(env, cookie, 7002, 'closegh');
    await env.WORKSPACES.get(env.WORKSPACES.idFromName('identity:github:7002')).fetch('http://workspace/command', {
      method: 'POST',
      body: JSON.stringify({ op: 'identity_claim', account, key: 'identity:github:7002', replace: true }),
    });

    await closure(cookie, { confirm: account });

    const fresh = await signInWith(env, identity(7002, 'closegh', 'closegh_new@example.com'), await sha('a'.repeat(64)));
    expect(fresh).toMatchObject({ kind: 'signed_in', username: 'closegh', created: true });
  });

  it('asks for the handle, a recent sign-in and a person', async () => {
    const { cookie, account } = await person('close_proof');

    expect((await closure(cookie, { confirm: 'someone-else' })).status).toBe(400);
    expect(await exists(account)).toBe(true);

    // Signed in sixteen minutes ago, as the session's expiry says.
    await runInDurableObject(env.WORKSPACES.get(env.WORKSPACES.idFromName(`account:${account}`)), (_: unknown, state: DurableObjectState) => {
      state.storage.sql.exec(
        "UPDATE workspace_records SET payload=json_set(payload,'$.expires',json_extract(payload,'$.expires')-960000) WHERE id LIKE 'session:%'",
      );
    });
    const stale = await closure(cookie, { confirm: account });
    expect((await stale.json<any>()).error.code).toBe('SIGN_IN_AGAIN');
    expect(await exists(account)).toBe(true);

    const pat = await api('/tokens', { cookie }, { body: { name: 'x', scopes: ['repo:admin'] } }, env);
    const bearer = await platformFetch(
      new Request('https://yoneda/api/v1/account/closure', {
        method: 'POST',
        headers: { authorization: `Bearer ${pat.body.token}` },
        body: JSON.stringify({ confirm: account }),
      }),
      env,
    );
    expect(bearer.status).toBe(401);
  });

  it('revokes its tokens and takes its GitHub App off', async () => {
    const hub = await new FakeGitHub().keys();
    const { cookie, account } = await person('close_keys');
    await linkGitHub(env, cookie, 7003, 'closekeys');
    hub.install(9700, 7003, 'closekeys');
    const original = globalThis.fetch;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input instanceof Request ? input.url : input);
      return (await hub.handle(url, init)) ?? original(input, init);
    });
    const target = hub.env(env);
    await platformFetch(new Request('https://yoneda/api/v1/github/connect', { headers: { cookie } }), target);
    const pat = await api('/tokens', { cookie }, { body: { name: 'x', scopes: ['repo:read'] } }, target);

    await closure(cookie, { confirm: account }, target);

    expect(hub.installations.has(9700)).toBe(false);
    expect((await api('/repos', { token: pat.body.token }, {}, target)).status).toBe(401);
    const left = await env.INDEX.prepare('SELECT 1 FROM platform_tokens WHERE workspace=?').bind(account).first();
    expect(left).toBeNull();
  });

  it('leaves others’ repositories and organizations, so a new owner of the name gets nothing', async () => {
    const host = await person('close_host');
    const shared = await repoOf(host.owner, 'shared');
    const guest = await person('close_guest');
    await api(`/repos/${shared}/members`, host.owner, { body: { account: guest.account, role: 'read' } }, env);
    await api('/orgs', host.owner, { body: { name: 'closeorg' } }, env);
    await api('/orgs/closeorg/members', host.owner, { body: { account: guest.account, role: 'member' } }, env);
    expect((await api(`/repos/${shared}`, guest.owner, {}, env)).status).toBe(200);

    await closure(guest.cookie, { confirm: guest.account });

    const members = await api(`/repos/${shared}/members`, host.owner, {}, env);
    expect(JSON.stringify(members.body)).not.toContain(guest.account);
    const org = await api('/orgs/closeorg', host.owner, {}, env);
    expect(JSON.stringify(org.body.members)).not.toContain(guest.account);

    const reborn = await signup('close_guest');
    expect((await api(`/repos/${shared}`, { cookie: reborn }, {}, env)).status).toBe(404);
  });

  it('keeps its repositories on the purge schedule, and out of reach of the name', async () => {
    const { cookie, account, owner } = await person('close_tomb');
    const id = await repoOf(owner, 'kept');

    await closure(cookie, { confirm: account });

    const listed = await env.INDEX.prepare('SELECT workspace,purge_at FROM platform_deleted_repos WHERE id=?')
      .bind(id)
      .first<{ workspace: string; purge_at: number }>();
    expect(listed?.workspace).toMatch(/^closed:/);
    expect(listed?.purge_at).toBeGreaterThan(Date.now());
    const reborn = await signup('close_tomb');
    expect((await api('/repos/deleted', { cookie: reborn }, {}, env)).body.repos).toEqual([]);
    const restore = await api(`/repos/${id}/restore`, { cookie: reborn }, { method: 'POST', body: {} }, env);
    expect(restore.status).not.toBe(200);
    expect((await api(`/repos/${id}`, { cookie: reborn }, {}, env)).status).toBeGreaterThanOrEqual(400);
  });

  it('takes its own forks first', async () => {
    const { cookie, account, owner } = await person('close_forks');
    const parent = await repoOf(owner, 'parent');
    const fork = await api(`/repos/${parent}/fork`, owner, { body: { name: 'child' } }, env);
    expect(fork.status).toBe(200);

    const done = await closure(cookie, { confirm: account });

    expect(await done.json()).toMatchObject({ closed: true, repos: 2 });
  });
});

describe('it refuses, and changes nothing', () => {
  const refused = async (cookie: string, account: string, reason: string, target: Env = env) => {
    const preview = await (await closure(cookie, undefined, target)).json<any>();
    expect(preview.refusals.map((r: any) => r.reason)).toContain(reason);
    const answer = await closure(cookie, { confirm: account }, target);
    expect(answer.status).toBe(409);
    expect(await exists(account)).toBe(true);
  };

  it('for an organization left with no owner', async () => {
    const { cookie, account, owner } = await person('close_owner');
    const other = await person('close_member');
    await api('/orgs', owner, { body: { name: 'closeown' } }, env);
    await api('/orgs/closeown/members', owner, { body: { account: other.account, role: 'member' } }, env);
    const id = await repoOf(owner, 'stays');

    await refused(cookie, account, 'org');

    expect((await api(`/repos/${id}`, owner, {}, env)).status).toBe(200);
  });

  it('for an organization with no one else in it', async () => {
    const { cookie, account, owner } = await person('close_solo');
    await api('/orgs', owner, { body: { name: 'closesolo' } }, env);

    await refused(cookie, account, 'org');
  });

  it('not for an organization with another owner', async () => {
    const { cookie, account, owner } = await person('close_second');
    const other = await person('close_first');
    await api('/orgs', owner, { body: { name: 'closetwo' } }, env);
    await api('/orgs/closetwo/members', owner, { body: { account: other.account, role: 'owner' } }, env);

    expect((await closure(cookie, { confirm: account })).status).toBe(200);
  });

  it('under a legal hold, on the account or one repository', async () => {
    const held = { ...env, LEGAL_HOLD: 'on' } as unknown as Env;
    const { cookie, account, owner } = await person('close_held');
    const id = await repoOf(owner, 'held');
    await workspace(env, account, { op: 'hold_operator_set', repo: id, operator: 'op' });

    await refused(cookie, account, 'hold', held);

    expect((await api(`/repos/${id}`, owner, {}, env)).status).toBe(200);
  });

  it('while a repository imports', async () => {
    const { cookie, account, owner } = await person('close_import');
    const id = await repoOf(owner, 'busy');
    await env.OBJECTS.put(`platform/v1/${id}/import-asked.json`, JSON.stringify({ repo: id, url: 'https://github.com/a/b.git' }));
    const PLATFORM_IMPORT = { get: async () => ({ status: async () => ({ status: 'running' }) }) };

    await refused(cookie, account, 'import', { ...env, PLATFORM_IMPORT } as unknown as Env);
  });

  it('for a repository someone else forked, naming it', async () => {
    const { cookie, account, owner } = await person('close_parent');
    const parent = await repoOf(owner, 'public');
    await api(`/repos/${parent}/visibility`, owner, { method: 'PUT', body: { visibility: 'public' } }, env);
    const other = await person('close_forker');
    const fork = await api(`/repos/${parent}/fork`, other.owner, { body: { name: 'theirs' } }, env);
    expect(fork.status).toBe(200);

    await refused(cookie, account, 'forks');

    expect((await api(`/repos/${parent}`, owner, {}, env)).status).toBe(200);
  });
});

describe('a run that dies part way', () => {
  it.each(['account_credentials_end', 'identity_claim_release', 'org_member_remove', 'account_close'])(
    'is finished by running it again, from %s',
    async (op) => {
      const name = `close_${op.slice(0, 8)}`;
      const { cookie, account, owner } = await person(name);
      await linkGitHub(env, cookie, 7100 + op.length, `gh${op.length}`);
      const host = await person(`${name}h`);
      await api('/orgs', host.owner, { body: { name: `o${op.length}x${op.charCodeAt(1)}` } }, env);
      await api(`/orgs/o${op.length}x${op.charCodeAt(1)}/members`, host.owner, { body: { account, role: 'member' } }, env);
      await repoOf(owner, 'a');

      await expect(closeAccount(crashingAt(op), 'self', account)).rejects.toThrow('The Worker died');

      expect(await exists(account)).toBe(true);
      expect(await closeAccount(env, 'self', account)).toMatchObject({ closed: true });
      expect(await exists(account)).toBe(false);
      expect(await row(account)).toBeNull();
      expect(await closeAccount(env, 'self', account)).toEqual({ closed: false });
    },
  );

  it('finishes when a repository’s deletion is what failed', async () => {
    const { account, owner } = await person('close_repo');
    await repoOf(owner, 'one');
    await repoOf(owner, 'two');
    const broken = failingOp(env, 'repo_delete');

    await expect(closeAccount(broken, 'self', account)).rejects.toBeDefined();

    expect((await closeAccount(env, 'self', account)).closed).toBe(true);
    expect((await api('/repos', owner, {}, env)).status).toBe(401);
  });

  it('can be signed in to and finished by its owner, after its sessions ended', async () => {
    const { cookie, account } = await person('close_back');
    await linkGitHub(env, cookie, 7200, 'closeback');

    await expect(closeAccount(crashingAt('identity_claim_release'), 'self', account)).rejects.toThrow('The Worker died');

    expect((await closure(cookie)).status).toBe(401);
    const login = await bindings.SELF.fetch('https://yoneda/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'close_back@example.com', password: 'long platform test password' }),
    });
    expect(login.status).toBe(200);
    const back = (login.headers.get('set-cookie') ?? '').split(';')[0];
    expect((await closure(back, { confirm: account })).status).toBe(200);
    expect(await exists(account)).toBe(false);
  });
});

describe('the operators’ version', () => {
  it('says what would go, and only a confirm by name does it', async () => {
    const { account, owner } = await person('close_op');
    await repoOf(owner, 'one');

    const dry = await closeByOperator(env, 'operator', account, {});

    expect(dry).toMatchObject({ dry_run: true, repos: 1, refusals: [] });
    expect(await exists(account)).toBe(true);
    await expect(closeByOperator(env, 'operator', account, { confirm: 'other' })).rejects.toMatchObject({ code: 'INVALID_INPUT' });

    expect(await closeByOperator(env, 'operator', account, { confirm: account })).toMatchObject({ closed: true });
    expect(await exists(account)).toBe(false);
    const row = await env.INDEX.prepare("SELECT target FROM admin_audit WHERE action='account.close' ORDER BY id DESC").first<{ target: string }>();
    expect(row?.target).toMatch(/^closed:/);
  });
});

