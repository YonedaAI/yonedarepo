// The org audit log through the API, behind AUDIT_LOG: what reaches `audit:<org>` and when,
// who may read it, its export, and that a failed copy costs the action nothing.
import { env as bindings, runInDurableObject } from 'cloudflare:test';
import { expect, it, vi } from 'vitest';
import { withWaitUntil } from '../../cloudflare/worker/background';
import { csvCell } from '../../cloudflare/worker/platform-audit-export';
import { platformFetch } from '../../cloudflare/worker/platform-routes';
import type { Env, Json } from '../../cloudflare/worker/types';
import { auditLog, workspace } from '../../cloudflare/worker/workspace';
import { api, scoped, signup, usePlatformFixture } from './repo-fixture';

usePlatformFixture();

const on = { ...scoped, AUDIT_LOG: 'on' } as unknown as Env;
const ED25519 =
  'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIPABZXfg3RaL8nBzQXBqjmhNRoourGMePyLCIP1iMDqH test@ed25519';

const make = (auth: { cookie: string }, org = 'acme') =>
  api('/orgs', auth, { body: { name: org } }, on);
const add = (auth: { cookie: string }, account: string, role = 'member', org = 'acme') =>
  api(`/orgs/${org}/members`, auth, { body: { account, role } }, on);
const audit = (auth: { cookie?: string; token?: string }, query = '', org = 'acme') =>
  api(`/orgs/${org}/audit${query}`, auth, {}, on);
const kinds = (rows: { kind: string }[]) => rows.map((r) => r.kind);
async function token(auth: { cookie: string }, scopes: string[], org: string | null = null) {
  const made = await api('/tokens', auth, { body: { name: 'ci', scopes, org, expires_days: 1 } }, on);
  expect(made.status).toBe(200);
  return made.body as { id: string; token: string };
}
/** An `AUDIT_LOG` environment whose `audit:` instances fail. */
function broken(): Env {
  const real = bindings.WORKSPACES as unknown as DurableObjectNamespace;
  const WORKSPACES = {
    get: (id: DurableObjectId) => real.get(id),
    idFromName(name: string) {
      if (name.startsWith('audit:')) throw new Error('audit instance down');
      return real.idFromName(name);
    },
  };
  return { ...on, WORKSPACES } as unknown as Env;
}
/** The person's own log, oldest first. */
const ownEvents = (account: string) =>
  runInDurableObject(
    bindings.WORKSPACES.get(bindings.WORKSPACES.idFromName(`account:${account}`)),
    (_, state) =>
      state.storage.sql
        .exec<{ kind: string; data: string }>(
          "SELECT kind,data FROM workspace_events WHERE kind LIKE 'auth.%' ORDER BY seq",
        )
        .toArray(),
  );

it('is off unless switched on: no route, no log, no sign-in rows', async () => {
  const alice = { cookie: await signup('audit_off') };
  await api('/orgs', alice, { body: { name: 'acme' } });
  expect((await api('/orgs/acme', alice)).body.audit_log).toBeUndefined();
  expect((await api('/orgs/acme/audit', alice)).status).toBe(404);
  expect((await api('/orgs/acme/audit/export', alice)).status).toBe(404);
  expect((await auditLog(scoped, 'acme', { op: 'audit_read' })).items).toEqual([]);
  await platformFetch(
    new Request('https://yoneda/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username: 'audit_off', password: 'long platform test password' }),
    }),
    scoped,
  );
  expect(await ownEvents('audit_off')).toEqual([]);
});

it('org changes reach the log with their actors, newest first and paged by seq', async () => {
  const alice = { cookie: await signup('audit_alice') };
  await signup('audit_bob');
  await make(alice);
  expect((await api('/orgs/acme', alice, {}, on)).body.audit_log).toBe(true);
  await add(alice, 'audit_bob');
  await api('/orgs/acme/teams', alice, { body: { name: 'devs' } }, on);
  await api('/orgs/acme/teams/devs/members', alice, { body: { account: 'audit_bob' } }, on);
  await api('/orgs/acme/teams/devs/members/audit_bob', alice, { method: 'DELETE' }, on);
  await api('/orgs/acme/teams/devs', alice, { method: 'DELETE' }, on);
  await api('/orgs/acme/members/audit_bob', alice, { method: 'DELETE' }, on);
  const { body } = await audit(alice);
  expect(kinds(body.items)).toEqual([
    'org.member_removed',
    'org.team_deleted',
    'org.team_member_removed',
    'org.team_member_added',
    'org.team_created',
    'org.member_put',
    'org.created',
  ]);
  for (const row of body.items) expect(row.actor).toBe('user:audit_alice');
  expect(body.items[5]).toMatchObject({
    seq: 2,
    source: 'account:acme',
    source_seq: 2,
    details: { account: 'audit_bob', role: 'member' },
  });
  expect(body.next).toBeNull();

  const first = await audit(alice, '?limit=3');
  expect(first.body.items.map((r: Json) => r.seq)).toEqual([7, 6, 5]);
  expect(first.body.next).toBe(5);
  const second = await audit(alice, `?limit=3&before=${first.body.next}`);
  expect(second.body.items.map((r: Json) => r.seq)).toEqual([4, 3, 2]);
  expect(kinds((await audit(alice, '?kind=org.team_created')).body.items)).toEqual([
    'org.team_created',
  ]);
  expect((await audit(alice, '?actor=audit_alice')).body.items).toHaveLength(7);
  expect((await audit(alice, '?actor=user:audit_bob')).body.items).toEqual([]);
  expect((await api('/orgs/acme/audit/verify', alice, {}, on)).body).toEqual({
    ok: true,
    checked: 7,
    next: null,
  });
  for (const bad of ['?before=x', '?kind=DROP%20TABLE', '?limit=0', '?actor=%3Dx'])
    expect((await audit(alice, bad)).status, bad).toBe(400);
});

it('only owners read it; tokens need repo:admin and reach only their own org', async () => {
  const alice = { cookie: await signup('audit_owner') };
  const bob = { cookie: await signup('audit_member') };
  const eve = { cookie: await signup('audit_stranger') };
  await make(alice);
  await make(alice, 'other');
  await add(alice, 'audit_member');
  await audit(alice);

  expect((await audit(bob)).status).toBe(403);
  expect((await audit(eve)).status).toBe(403);
  expect((await api('/orgs/acme/audit/verify', bob, {}, on)).status).toBe(403);
  expect((await api('/orgs/acme/audit/export', bob, {}, on)).status).toBe(403);
  const anonymous = await platformFetch(new Request('https://yoneda/api/v1/orgs/acme/audit'), on);
  expect(anonymous.status).toBe(401);

  const reader = await token(alice, ['repo:read']);
  expect((await audit({ token: reader.token })).status).toBe(403);
  expect((await api('/orgs/acme/audit/export', { token: reader.token }, {}, on)).status).toBe(403);
  const admin = await token(alice, ['repo:admin']);
  expect((await audit({ token: admin.token })).status).toBe(200);
  const limited = await token(alice, ['repo:admin'], 'other');
  expect((await audit({ token: limited.token })).status).toBe(403);
  // A member's admin token still isn't an owner's.
  const members = await token(bob, ['repo:admin']);
  expect((await audit({ token: members.token })).status).toBe(403);
});

it('a failed audit write fails nothing, and the next copy catches up', async () => {
  const alice = { cookie: await signup('audit_down') };
  await signup('audit_late');
  await make(alice);
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const down = broken();
  const put = await api('/orgs/acme/members', alice, { body: { account: 'audit_late', role: 'member' } }, down);
  expect(put.status).toBe(200);
  expect(warn).toHaveBeenCalled();
  expect((await api('/tokens', alice, { body: { name: 'x', scopes: ['repo:read'], org: 'acme', expires_days: 1 } }, down)).status).toBe(200);
  const key = await api('/ssh-keys', alice, { body: { title: 'l', key: ED25519 } }, down);
  expect(key.status).toBe(200);

  await api('/orgs/acme/teams', alice, { body: { name: 'devs' } }, on);
  expect(kinds((await audit(alice)).body.items)).toContain('org.member_put');
});

it('copies run after the answer, so a slow log costs the action nothing', async () => {
  const alice = { cookie: await signup('audit_slow') };
  await make(alice);
  const later: Promise<unknown>[] = [];
  const answer = await withWaitUntil(
    (work) => later.push(work),
    () => api('/orgs/acme/teams', alice, { body: { name: 'devs' } }, on),
  );
  expect(answer.status).toBe(200);
  // The copy was handed to waitUntil, not awaited.
  expect(later).toHaveLength(1);
  await Promise.all(later);
  expect((await auditLog(on, 'acme', { op: 'audit_read' })).items[0].kind).toBe('org.team_created');
});

it("a member's org-limited tokens and SSH keys reach the org; other activity doesn't", async () => {
  const alice = { cookie: await signup('audit_owns') };
  const bob = { cookie: await signup('audit_works') };
  await make(alice);
  await add(alice, 'audit_works');
  const limited = await token(bob, ['repo:read'], 'acme');
  const free = await token(bob, ['repo:read']);
  await api(`/tokens/${free.id}`, bob, { method: 'DELETE' }, on);
  await api(`/tokens/${limited.id}`, bob, { method: 'DELETE' }, on);
  const key = await api('/ssh-keys', bob, { body: { title: 'laptop', key: ED25519 } }, on);
  await api(`/ssh-keys/${key.body.id}`, bob, { method: 'DELETE' }, on);
  await platformFetch(
    new Request('https://yoneda/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username: 'audit_works', password: 'long platform test password' }),
    }),
    on,
  );
  const rows = (await audit(alice)).body.items as Json[];
  expect(kinds(rows.filter((r) => r.source === 'account:audit_works'))).toEqual([
    'ssh_key.removed',
    'ssh_key.added',
    'pat.revoked',
    'pat.created',
  ]);
  expect(rows.find((r) => r.kind === 'pat.created')).toMatchObject({
    actor: 'user:audit_works',
    details: { id: limited.id, org: 'acme', scopes: ['repo:read'] },
  });
  expect(JSON.stringify(rows)).not.toContain(free.id);
  expect(JSON.stringify(rows)).not.toContain('laptop');
  expect(JSON.stringify(rows)).not.toContain('auth.');
});

it("a stranger's token limited to an org says nothing to it", async () => {
  const alice = { cookie: await signup('audit_holder') };
  const eve = { cookie: await signup('audit_eve') };
  await make(alice);
  await token(eve, ['repo:read'], 'acme');
  const rows = (await audit(alice)).body.items as Json[];
  expect(kinds(rows)).toEqual(['org.created']);
});

it("sign-ins and device approvals go to the person's own log", async () => {
  const cookie = await signup('audit_signs');
  const post = (path: string, body: Json, headers: Record<string, string> = {}) =>
    platformFetch(
      new Request(`https://yoneda${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify(body),
      }),
      on,
    );
  const login = { username: 'audit_signs', password: 'long platform test password' };
  expect((await post('/api/auth/login', login)).status).toBe(200);
  expect((await post('/api/auth/login', { ...login, password: 'wrong password' })).status).toBe(401);
  await post('/api/auth/logout', {}, { cookie });
  const code = await (await post('/api/v1/device/code', { client_name: 'yoneda', host: 'mac' })).json<Json>();
  const approve = {
    user_code: code.user_code,
    scopes: ['repo:read'],
    expires_days: 1,
  };
  expect((await post('/api/v1/device/approve', approve, { cookie: await signup('audit_signs2') })).status).toBe(200);
  const seen = await ownEvents('audit_signs');
  expect(kinds(seen)).toEqual(['auth.login', 'auth.login_failed', 'auth.logout']);
  const other = await ownEvents('audit_signs2');
  expect(other.map((e) => [e.kind, JSON.parse(e.data)])).toEqual([
    ['auth.device_approved', { client: 'yoneda', host: 'mac' }],
  ]);
});

const download = (path: string, auth: { cookie?: string }) =>
  platformFetch(
    new Request(`https://yoneda/api/v1${path}`, { headers: { cookie: auth.cookie ?? '' } }),
    on,
  );

it('exports JSON and CSV, every page, with formula cells neutralised', async () => {
  const alice = { cookie: await signup('audit_exports') };
  await make(alice);
  await audit(alice);
  const events = Array.from({ length: 450 }, (_, i) => ({
    seq: i + 1,
    kind: 'org.team_created',
    at: 1000 + i,
    data: { team: `t${i}`, id: i, actor: i === 449 ? '=HYPERLINK' : '@cmd', _secret: 'hunter2' },
  }));
  for (let i = 0; i < events.length; i += 200)
    await auditLog(on, 'acme', {
      op: 'audit_append',
      org: 'acme',
      source: 'account:elsewhere',
      events: events.slice(i, i + 200),
    });
  const json = await download('/orgs/acme/audit/export', alice);
  expect(json.status).toBe(200);
  expect(json.headers.get('content-type')).toContain('application/json');
  expect(json.headers.get('content-disposition')).toContain('acme-audit.json');
  const parsed = await json.json<{ org: string; items: Json[] }>();
  expect(parsed.org).toBe('acme');
  expect(parsed.items).toHaveLength(451);

  const csv = await download('/orgs/acme/audit/export?format=csv', alice);
  expect(csv.status).toBe(200);
  expect(csv.headers.get('content-type')).toContain('text/csv');
  expect(csv.headers.get('x-content-type-options')).toBe('nosniff');
  const text = await csv.text();
  const lines = text.trimEnd().split('\r\n');
  expect(lines[0]).toBe('seq,at,kind,actor,source,source_seq,details,previous,hash');
  expect(lines).toHaveLength(452);
  expect(lines[1].split(',')[3]).toBe("'=HYPERLINK");
  expect(lines[2].split(',')[3]).toBe("'@cmd");
  expect(text).not.toContain('_secret');
  expect(text).not.toContain('hunter2');

  const filtered = await download('/orgs/acme/audit/export?format=csv&kind=org.created', alice);
  expect((await filtered.text()).trimEnd().split('\r\n')).toHaveLength(2);
  expect((await download('/orgs/acme/audit/export?format=xml', alice)).status).toBe(400);
});

it('neutralises every leading formula character and quotes CSV', () => {
  for (const cell of ['=1+1', '+1', '-1', '@x', '\t=1', '\r=1', ' =1'])
    expect(csvCell(cell).replace(/^"/, '').startsWith("'")).toBe(true);
  expect(csvCell('plain')).toBe('plain');
  expect(csvCell('a,b')).toBe('"a,b"');
  expect(csvCell('say "hi"')).toBe('"say ""hi"""');
  expect(csvCell(null)).toBe('');
  expect(csvCell(7)).toBe('7');
  expect(csvCell({ a: 1 })).toBe('"{""a"":1}"');
});

it('a tampered log shows on the verify route', async () => {
  const alice = { cookie: await signup('audit_tamper') };
  await make(alice);
  await audit(alice);
  await runInDurableObject(
    bindings.WORKSPACES.get(bindings.WORKSPACES.idFromName('audit:acme')),
    (_, state) => {
      state.storage.sql.exec("UPDATE workspace_events SET kind='org.deleted' WHERE seq=1");
    },
  );
  expect((await api('/orgs/acme/audit/verify', alice, {}, on)).body).toMatchObject({
    ok: false,
    broken_at: 1,
  });
});

it('an org deleted keeps its last event in the log', async () => {
  const alice = { cookie: await signup('audit_gone') };
  await make(alice);
  await api('/orgs/acme?confirm=acme', alice, { method: 'DELETE' }, on);
  const log = await auditLog(on, 'acme', { op: 'audit_read' });
  expect(kinds(log.items)).toEqual(['org.deleted', 'org.created']);
  expect(log.items[0].actor).toBe('user:audit_gone');
  await workspace(on, 'audit_gone', { op: 'audit_targets' });
});
