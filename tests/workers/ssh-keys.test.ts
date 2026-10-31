// Git over SSH, platform side: per-account SSH keys (REST), the gateway's internal endpoints
// (JWT-authenticated key lookup and session tokens) and the `ysh_` session token on smart
// HTTP, held to one repository and service and refused at once when its key is removed.
import { SignJWT } from 'jose';
import { expect, it, vi } from 'vitest';
import { platformFetch } from '../../cloudflare/worker/platform-routes';
import type { Env } from '../../cloudflare/worker/types';
import { workspace } from '../../cloudflare/worker/workspace';
import { api, author, file, scoped, signup, usePlatformFixture } from './repo-fixture';

usePlatformFixture();

const SECRET = 'test-ssh-gateway-secret-0123456789abcdef';
const target = { ...scoped, SSH_GATEWAY_SECRET: SECRET } as Env;
const ED25519 =
  'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIPABZXfg3RaL8nBzQXBqjmhNRoourGMePyLCIP1iMDqH test@ed25519';
const FINGERPRINT = 'SHA256:8EqRGtHv7KPU4JP7ITUpjcB1ZW5aJP4ISN49NDYsKWo';
const ECDSA =
  'ecdsa-sha2-nistp256 AAAAE2VjZHNhLXNoYTItbmlzdHAyNTYAAAAIbmlzdHAyNTYAAABBBLsUCMLZxezVKY0se9x00MY5l5i9wk6Lee8mWXzj/N2IgwcI4tpUDnRZmGMGmAB1IFLCf0vnBiGU/mZRGxn10KA=';

async function jwt(secret = SECRET, claims: { iat?: number; exp?: string | number } = {}) {
  const token = new SignJWT({})
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuer('yoneda-ssh-gateway')
    .setAudience('yoneda-platform')
    .setIssuedAt(claims.iat)
    .setExpirationTime(claims.exp ?? '1m');
  return token.sign(new TextEncoder().encode(secret));
}

async function internal(path: string, body: unknown, authorization?: string, env: Env = target) {
  const response = await platformFetch(
    new Request(`https://yoneda/internal/ssh/${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: authorization ?? `Bearer ${await jwt()}` },
      body: JSON.stringify(body),
    }),
    env,
  );
  return { status: response.status, body: await response.json<any>() };
}

async function git(path: string, token: string, method = 'GET') {
  const response = await platformFetch(
    new Request(`https://yoneda/git/${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, 'git-protocol': 'version=2' },
      body: method === 'POST' ? '0000' : undefined,
    }),
    target,
  );
  return { status: response.status, text: new TextDecoder().decode(await response.arrayBuffer()) };
}

async function repo(cookie: string, name: string) {
  const created = await api('/repos', { cookie }, { body: { name, files: [file('a.md', 'a\n')], author } });
  expect(created.status).toBe(200);
  return created.body.id as string;
}

it('adds, lists and removes SSH keys; a key belongs to one account at a time', async () => {
  const alice = await signup('ssh_alice');
  const added = await api('/ssh-keys', { cookie: alice }, { body: { title: 'laptop', key: ED25519 } });
  expect(added.status).toBe(200);
  expect(added.body).toMatchObject({ title: 'laptop', fingerprint: FINGERPRINT, algorithm: 'ssh-ed25519', last_used_at: null });
  expect(added.body.id).toMatch(/^ssh_[0-9a-f]{16}$/);
  const listed = await api('/ssh-keys', { cookie: alice });
  expect(listed.body.keys.map((k: any) => k.id)).toEqual([added.body.id]);
  expect(listed.body.ssh).toEqual({ front_door: null, host: null, clone_url: null, ssh_config: null });
  expect(JSON.stringify(listed.body)).not.toContain('AAAAC3');

  expect((await api('/ssh-keys', { cookie: alice }, { body: { title: 'again', key: ED25519 } })).status).toBe(409);
  expect((await api('/ssh-keys', { cookie: alice }, { body: { title: 'bad', key: 'ssh-rsa AAAA' } })).status).toBe(400);
  const bob = await signup('ssh_bob');
  const taken = await api('/ssh-keys', { cookie: bob }, { body: { title: 'mine', key: ED25519 } });
  expect([taken.status, taken.body.error.code]).toEqual([409, 'ALREADY_EXISTS']);
  expect((await api('/ssh-keys', { cookie: bob })).body.keys).toEqual([]);

  // Tokens: repo:admin manages keys; adding one needs an unrestricted token.
  const reader = (await api('/tokens', { cookie: alice }, { body: { name: 'r', scopes: ['repo:read'] } })).body;
  expect((await api('/ssh-keys', { token: reader.token })).status).toBe(403);
  const r = await repo(alice, 'ssh-scoped');
  const narrow = (await api('/tokens', { cookie: alice }, { body: { name: 'n', scopes: ['repo:admin'], repos: [r] } })).body;
  expect((await api('/ssh-keys', { token: narrow.token }, { body: { title: 'x', key: ECDSA } })).status).toBe(403);
  const admin = (await api('/tokens', { cookie: alice }, { body: { name: 'a', scopes: ['repo:admin'] } })).body;
  expect((await api('/ssh-keys', { token: admin.token }, { body: { title: 'ci', key: ECDSA } })).status).toBe(200);
  expect((await api('/ssh-keys', { token: admin.token })).body.keys).toHaveLength(2);

  const removed = await api(`/ssh-keys/${added.body.id}`, { cookie: alice }, { method: 'DELETE' });
  expect(removed.body).toEqual({ id: added.body.id, deleted: true });
  expect((await api(`/ssh-keys/${added.body.id}`, { cookie: alice }, { method: 'DELETE' })).status).toBe(404);
  // Once removed, another account may register it, and lookups find the new holder.
  expect((await api('/ssh-keys', { cookie: bob }, { body: { title: 'mine', key: ED25519 } })).status).toBe(200);
  expect((await internal('lookup', { fingerprint: FINGERPRINT })).body.account).toBe('ssh_bob');
});

const token = async (cookie: string, name: string, scopes: string[], repos?: string[]) =>
  (await api('/tokens', { cookie }, { body: { name, scopes, ...(repos && { repos }) } })).body;

it('holds an account:ssh-keys token to /ssh-keys: it lists and removes, and nothing else', async () => {
  const cookie = await signup('ssh_only');
  const r = await repo(cookie, 'ssh-only');
  const only = await token(cookie, 'only', ['account:ssh-keys']);
  expect(only.scopes).toEqual(['account:ssh-keys']);
  const auth = { token: only.token };

  const key = (await api('/ssh-keys', { cookie }, { body: { title: 'laptop', key: ED25519 } })).body;
  const listed = await api('/ssh-keys', auth);
  expect(listed.status).toBe(200);
  expect(listed.body.keys.map((k: any) => k.id)).toEqual([key.id]);
  expect((await api(`/ssh-keys/${key.id}`, auth, { method: 'DELETE' })).status).toBe(200);

  // A key reads, writes and lands everywhere, so only a token that can already do so adds one.
  const added = await api('/ssh-keys', auth, { body: { title: 'x', key: ED25519 } });
  expect([added.status, added.body.error.code]).toEqual([403, 'FORBIDDEN']);
  expect((await api('/ssh-keys', { cookie })).body.keys).toEqual([]);

  const body = { body: { name: 'nope' } };
  for (const [path, init] of [
    ['/repos', {}],
    ['/repos', body],
    ['/repos/import', body],
    [`/repos/${r}`, {}],
    [`/repos/${r}/refs`, {}],
    [`/repos/${r}/tree`, {}],
    [`/repos/${r}/tokens`, {}],
    [`/repos/${r}/policy`, {}],
    [`/repos/${r}/members`, {}],
    [`/repos/${r}?confirm=ssh-only`, { method: 'DELETE' }],
    [`/repos/${r}/mcp`, { body: { jsonrpc: '2.0', id: 1, method: 'tools/list' } }],
    ['/mcp', { body: { jsonrpc: '2.0', id: 1, method: 'tools/list' } }],
    ['/tokens', {}],
    ['/tokens', { body: { name: 'wider', scopes: ['repo:admin'] } }],
    [`/tokens/${only.id}`, { method: 'DELETE' }],
    ['/device/approve', { body: { user_code: 'BCDFGHJK', scopes: ['repo:admin'], expires_days: 1 } }],
    ['/orgs', {}],
    ['/orgs', body],
    ['/activity', {}],
    ['/support', { body: { subject: 's', message: 'm' } }],
    ['/admin/accounts', {}],
    ['/account/avatar', {}],
    ['/resolve/ssh_only/ssh-only', {}],
    [`/repos/${r}/path`, {}],
  ] as [string, { method?: string; body?: unknown }][]) {
    const answer = await api(path, auth, init);
    expect([path, answer.status, answer.body?.error?.code]).toEqual([path, 403, 'FORBIDDEN']);
  }
  for (const smart of [
    `${r}.git/info/refs?service=git-upload-pack`,
    `${r}.git/info/refs?service=git-receive-pack`,
  ])
    expect((await git(smart, only.token)).status).toBe(403);
  const basic = await platformFetch(
    new Request(`https://yoneda/git/${r}.git/info/refs?service=git-upload-pack`, {
      headers: { authorization: `Basic ${btoa(`x:${only.token}`)}`, 'git-protocol': 'version=2' },
    }),
    target,
  );
  expect(basic.status).toBe(403);
});

it('adds a key with the CLI login scopes; repo:admin still manages keys and others do not', async () => {
  const cookie = await signup('ssh_login');
  const r = await repo(cookie, 'ssh-login');
  const login = await token(cookie, 'login', ['repo:read', 'repo:write', 'repo:land', 'account:ssh-keys']);
  const added = await api('/ssh-keys', { token: login.token }, { body: { title: 'laptop', key: ED25519 } });
  expect(added.status).toBe(200);
  expect(added.body.ssh).toBeDefined();
  // It keeps the repository scopes it holds, and gains no others.
  expect((await api(`/repos/${r}`, { token: login.token })).status).toBe(200);
  expect((await api('/repos', { token: login.token })).body.repos.map((x: any) => x.id)).toEqual([r]);
  expect((await api('/tokens', { token: login.token })).status).toBe(403);
  expect((await api('/repos', { token: login.token }, { body: { name: 'more' } })).status).toBe(403);
  expect((await api(`/repos/${r}/tokens`, { token: login.token })).status).toBe(403);

  // Short of what a key can do, or short of every repository, it cannot add one.
  for (const scopes of [['repo:read', 'account:ssh-keys'], ['repo:read', 'repo:write', 'account:ssh-keys']]) {
    const short = await token(cookie, 'short', scopes);
    expect((await api('/ssh-keys', { token: short.token }, { body: { title: 'x', key: ECDSA } })).status).toBe(403);
    expect((await api('/ssh-keys', { token: short.token })).status).toBe(200);
    await api(`/tokens/${short.id}`, { cookie }, { method: 'DELETE' });
  }
  const narrow = await token(cookie, 'narrow', ['repo:read', 'repo:write', 'repo:land', 'account:ssh-keys'], [r]);
  expect((await api('/ssh-keys', { token: narrow.token }, { body: { title: 'x', key: ECDSA } })).status).toBe(403);

  // Without the scope: repository scopes alone stay out, repo:admin stays in.
  const old = await token(cookie, 'old', ['repo:read', 'repo:write', 'repo:land']);
  const refused = await api('/ssh-keys', { token: old.token });
  expect([refused.status, refused.body.error.message]).toEqual([403, 'Token lacks the account:ssh-keys scope']);
  const admin = await token(cookie, 'admin', ['repo:admin']);
  expect((await api('/ssh-keys', { token: admin.token })).status).toBe(200);
  expect((await api('/ssh-keys', { token: admin.token }, { body: { title: 'x', key: ECDSA } })).status).toBe(200);
});

const LOGIN = ['repo:read', 'repo:write', 'repo:land', 'account:ssh-keys'];
/** Who the fingerprint index names, or its error code. */
async function claimHolder() {
  const index = target.WORKSPACES.get(target.WORKSPACES.idFromName(`sshkey:${FINGERPRINT}`));
  const answer = await index.fetch('http://workspace/command', {
    method: 'POST',
    body: JSON.stringify({ op: 'ssh_fp_get', fingerprint: FINGERPRINT }),
  });
  const body = await answer.json<any>();
  return body.account ?? body.error.code;
}

it('removes the keys a token added when it is revoked: the account check, the gateway and open sessions refuse at once', async () => {
  const cookie = await signup('ssh_revoke');
  const r = await repo(cookie, 'ssh-revoke');
  const login = await token(cookie, 'login', LOGIN);
  const other = await token(cookie, 'other', LOGIN);
  const key = (await api('/ssh-keys', { token: login.token }, { body: { title: 'laptop', key: ED25519 } })).body;
  const own = (await api('/ssh-keys', { cookie }, { body: { title: 'mine', key: ECDSA } })).body;
  const count = (await api('/tokens', { cookie })).body.tokens.find((t: any) => t.id === login.id).ssh_keys;
  expect(count).toBe(1);

  const lookup = { fingerprint: FINGERPRINT };
  const session = { account: 'ssh_revoke', key_id: key.id, fingerprint: FINGERPRINT, repo: r, service: 'git-upload-pack' };
  expect((await internal('lookup', lookup)).status).toBe(200);
  const open = (await internal('session', session)).body.token as string;
  expect((await git(`${r}.git/git-upload-pack`, open, 'POST')).status).toBe(200);

  // Adding the same key with another token moves nothing: only `login` takes it away.
  expect((await api('/ssh-keys', { token: other.token }, { body: { title: 'again', key: ED25519 } })).status).toBe(409);
  const unrelated = await api(`/tokens/${other.id}`, { cookie }, { method: 'DELETE' });
  expect(unrelated.body).toEqual({ id: other.id, revoked: true, removed_ssh_keys: [] });
  expect((await internal('lookup', lookup)).status).toBe(200);

  const revoked = await api(`/tokens/${login.id}`, { cookie }, { method: 'DELETE' });
  expect(revoked.body).toEqual({
    id: login.id,
    revoked: true,
    removed_ssh_keys: [{ id: key.id, title: 'laptop', fingerprint: FINGERPRINT }],
  });
  await expect(
    workspace(target, 'ssh_revoke', { op: 'ssh_key_check', key_id: key.id, fingerprint: FINGERPRINT }),
  ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  expect((await internal('lookup', lookup)).status).toBe(404);
  expect((await internal('session', session)).status).toBe(401);
  expect((await git(`${r}.git/git-upload-pack`, open, 'POST')).status).toBe(401);
  expect(await claimHolder()).toBe('NOT_FOUND');

  // The key the person added stays; a second revocation finds nothing.
  expect((await api('/ssh-keys', { cookie })).body.keys.map((k: any) => k.id)).toEqual([own.id]);
  expect((await api(`/tokens/${login.id}`, { cookie }, { method: 'DELETE' })).status).toBe(404);
});

it('keeps a revocation whose claim release fails: the key is gone and the claim grants nothing', async () => {
  const cookie = await signup('ssh_stale');
  const login = await token(cookie, 'login', LOGIN);
  const key = (await api('/ssh-keys', { token: login.token }, { body: { title: 'laptop', key: ED25519 } })).body;
  const namespace = scoped.WORKSPACES;
  const failing = {
    ...scoped,
    WORKSPACES: {
      idFromName: (name: string) => namespace.idFromName(name),
      get: (id: DurableObjectId) => ({
        fetch: async (url: string, init: { body: string }) => {
          if (JSON.parse(init.body).op === 'ssh_fp_release') throw new Error('index unavailable');
          return namespace.get(id).fetch(url, init);
        },
      }),
    },
  } as unknown as Env;
  const revoked = await api(`/tokens/${login.id}`, { cookie }, { method: 'DELETE' }, failing);
  expect([revoked.status, revoked.body.removed_ssh_keys[0].id]).toEqual([200, key.id]);
  expect(await claimHolder()).toBe('ssh_stale');
  expect((await internal('lookup', { fingerprint: FINGERPRINT })).status).toBe(404);
  // Another account takes the key over from the stale claim.
  const bob = await signup('ssh_stale_bob');
  expect((await api('/ssh-keys', { cookie: bob }, { body: { title: 'mine', key: ED25519 } })).status).toBe(200);
  expect((await internal('lookup', { fingerprint: FINGERPRINT })).body.account).toBe('ssh_stale_bob');
});

it('refuses a key another account holds and leaves nothing for the token to remove', async () => {
  const alice = await signup('ssh_held');
  const held = (await api('/ssh-keys', { cookie: alice }, { body: { title: 'laptop', key: ED25519 } })).body;
  const bob = await signup('ssh_held_bob');
  const login = await token(bob, 'login', LOGIN);
  const refused = await api('/ssh-keys', { token: login.token }, { body: { title: 'mine', key: ED25519 } });
  expect([refused.status, refused.body.error.code]).toEqual([409, 'ALREADY_EXISTS']);
  expect((await api('/tokens', { cookie: bob })).body.tokens[0].ssh_keys).toBe(0);
  expect((await api(`/tokens/${login.id}`, { cookie: bob }, { method: 'DELETE' })).body.removed_ssh_keys).toEqual([]);
  expect((await internal('lookup', { fingerprint: FINGERPRINT })).body).toEqual({ account: 'ssh_held', key_id: held.id });
});

it('answers the gateway only with a valid JWT, and only where SSH is configured', async () => {
  const alice = await signup('ssh_jwt');
  const added = (await api('/ssh-keys', { cookie: alice }, { body: { title: 'laptop', key: ED25519 } })).body;
  const lookup = { fingerprint: FINGERPRINT };
  expect(await internal('lookup', lookup)).toEqual({ status: 200, body: { account: 'ssh_jwt', key_id: added.id } });
  for (const authorization of [
    '',
    'Bearer not-a-jwt',
    `Bearer ${await jwt('another-secret-of-sufficient-length-0123')}`,
    // Expired, and issued too long ago though not expired.
    `Bearer ${await jwt(SECRET, { exp: Math.floor(Date.now() / 1000) - 5 })}`,
    `Bearer ${await jwt(SECRET, { iat: Math.floor(Date.now() / 1000) - 600, exp: '1h' })}`,
  ])
    expect((await internal('lookup', lookup, authorization)).status).toBe(401);
  expect((await internal('lookup', lookup, undefined, scoped)).status).toBe(404);
  expect((await internal('lookup', { fingerprint: 'SHA256:x' })).status).toBe(400);
  const unknown = 'SHA256:ZDqPuklpc5kPGUsaQ/6J56K/L5rvCHF/bqPISkpZcSk';
  expect((await internal('lookup', { fingerprint: unknown })).status).toBe(404);
  // A session needs a live key of that account and a real repository id and service.
  const session = { account: 'ssh_jwt', key_id: added.id, fingerprint: FINGERPRINT, repo: `r${'0'.repeat(20)}`, service: 'git-upload-pack' };
  expect((await internal('session', session)).body.token).toMatch(/^ysh_/);
  for (const bad of [{ service: 'sh' }, { service: 'toString' }, { repo: '../x' }, { key_id: 'pat_1' }])
    expect((await internal('session', { ...session, ...bad })).status).toBe(400);
  expect((await internal('session', { ...session, account: 'ssh_other' })).status).toBe(401);
  expect((await internal('session', { ...session, fingerprint: unknown })).status).toBe(401);
});

it('holds a session token to its repository and service, and refuses it once the key is removed', async () => {
  const alice = await signup('ssh_git');
  const [mine, other] = [await repo(alice, 'ssh-a'), await repo(alice, 'ssh-b')];
  const key = (await api('/ssh-keys', { cookie: alice }, { body: { title: 'laptop', key: ED25519 } })).body;
  const mint = async (repoId: string, service: string) =>
    (await internal('session', { account: 'ssh_git', key_id: key.id, fingerprint: FINGERPRINT, repo: repoId, service })).body
      .token as string;
  const fetch = await mint(mine, 'git-upload-pack');
  const advertised = await git(`${mine}.git/info/refs?service=git-upload-pack`, fetch);
  expect([advertised.status, advertised.text]).toEqual([200, expect.stringContaining('version 2')]);
  expect((await git(`${mine}.git/git-upload-pack`, fetch, 'POST')).status).toBe(200);
  // Not another service, repository or API surface; not when tampered with.
  expect((await git(`${mine}.git/info/refs?service=git-receive-pack`, fetch)).status).toBe(401);
  expect((await git(`${other}.git/info/refs?service=git-upload-pack`, fetch)).status).toBe(401);
  expect((await api('/repos', { token: fetch })).status).toBe(401);
  const tampered = `${fetch.slice(0, -2)}${fetch.endsWith('AA') ? 'BB' : 'AA'}`;
  expect((await git(`${mine}.git/info/refs?service=git-upload-pack`, tampered)).status).toBe(401);
  // A push token may push: the receive-pack advertisement needs write access.
  const push = await mint(mine, 'git-receive-pack');
  expect((await git(`${mine}.git/info/refs?service=git-receive-pack`, push)).status).toBe(200);
  expect((await api('/ssh-keys', { cookie: alice })).body.keys[0].last_used_at).toBeGreaterThan(0);

  // Removal is the revocation: the next request of an open session is refused.
  await api(`/ssh-keys/${key.id}`, { cookie: alice }, { method: 'DELETE' });
  expect((await git(`${mine}.git/git-upload-pack`, fetch, 'POST')).status).toBe(401);
  expect((await git(`${mine}.git/info/refs?service=git-receive-pack`, push)).status).toBe(401);
  expect((await internal('lookup', { fingerprint: FINGERPRINT })).status).toBe(404);
});

it('tells clients how to reach Git over SSH through the tunnel', async () => {
  const cookie = await signup('ssh_setup');
  const tunnel = { ...scoped, SSH_FRONT_DOOR: 'tunnel', SSH_HOST: 'ssh.dev.yonedarepo.com' } as Env;
  const added = await api('/ssh-keys', { cookie }, { body: { title: 'laptop', key: ED25519 } }, tunnel);
  const expected = {
    front_door: 'tunnel',
    host: 'ssh.dev.yonedarepo.com',
    clone_url: 'ssh://git@ssh.dev.yonedarepo.com/<repository id>.git',
    ssh_config: 'Host ssh.dev.yonedarepo.com\n  ProxyCommand cloudflared access ssh --hostname %h\n',
  };
  expect(added.body.ssh).toEqual(expected);
  expect((await api('/ssh-keys', { cookie }, {}, tunnel)).body.ssh).toEqual(expected);
  const connect = { ...tunnel, SSH_FRONT_DOOR: 'connect' } as Env;
  expect((await api('/ssh-keys', { cookie }, {}, connect)).body.ssh).toMatchObject({ front_door: 'connect', ssh_config: null });
});

it('logs the gateway\'s own state for wrangler tail, from the gateway only', async () => {
  const logged = vi.spyOn(console, 'log').mockImplementation(() => {});
  const exited = { event: 'tunnel.exited', detail: { exit_code: 1, tail: ['ERR failed to connect'] } };
  expect(await internal('status', exited)).toEqual({ status: 200, body: { recorded: true } });
  expect(logged).toHaveBeenCalledWith(
    JSON.stringify({ event: 'ssh.tunnel.exited', exit_code: 1, tail: ['ERR failed to connect'] }),
  );
  expect((await internal('status', { event: 'evil"event' })).status).toBe(400);
  expect((await internal('status', exited, 'Bearer nope')).status).toBe(401);
});
