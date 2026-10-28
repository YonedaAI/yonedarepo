// Git over SSH, platform side: per-account SSH keys (REST), the gateway's internal endpoints
// (JWT-authenticated key lookup and session tokens) and the `ysh_` session token on smart
// HTTP, held to one repository and service and refused at once when its key is removed.
import { SignJWT } from 'jose';
import { expect, it } from 'vitest';
import { platformFetch } from '../../cloudflare/worker/platform-routes';
import type { Env } from '../../cloudflare/worker/types';
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
