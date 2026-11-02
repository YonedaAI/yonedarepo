// Repository events through the API, behind AUDIT_LOG: each reaches its org's log with who
// did it, off means nothing, a failed action records nothing, one org never sees another's,
// a personal repository reaches no log, and a failed copy costs the action nothing and is
// picked up later.
import { env as bindings, runInDurableObject } from 'cloudflare:test';
import { expect, it, vi } from 'vitest';
import { withWaitUntil } from '../../cloudflare/worker/background';
import { purgeJob } from '../../cloudflare/worker/repo-admin';
import { deliverHook } from '../../cloudflare/worker/repo-hooks';
import { caller } from '../../cloudflare/worker/repo-ops';
import type { Env, Json } from '../../cloudflare/worker/types';
import { auditLog } from '../../cloudflare/worker/workspace';
import { api, author, drainObjects, file, queued, scoped, signup, usePlatformFixture } from './repo-fixture';

usePlatformFixture();

const on = { ...scoped, AUDIT_LOG: 'on' } as unknown as Env;
const undo = { ...on, REPO_UNDO_DAYS: '30' } as unknown as Env;
const policy = { required_checks: [], approvals: 0 };
type Auth = { cookie: string };

/** `AUDIT_LOG` on, with its `audit:` instances down. */
function broken(base: Env = on): Env {
  const real = bindings.WORKSPACES as unknown as DurableObjectNamespace;
  const WORKSPACES = {
    get: (id: DurableObjectId) => real.get(id),
    idFromName(name: string) {
      if (name.startsWith('audit:')) throw new Error('audit instance down');
      return real.idFromName(name);
    },
  };
  return { ...base, WORKSPACES } as unknown as Env;
}

const makeOrg = (auth: Auth, org: string) => api('/orgs', auth, { body: { name: org } }, on);
async function makeRepo(auth: Auth, org: string | null, name = 'app', target = on) {
  const body = { name, policy, files: [file('a.md', 'a\n')], author, ...(org && { owner: org }) };
  const made = await api('/repos', auth, { body }, target);
  expect(made.status).toBe(200);
  return made.body.id as string;
}
const repoRows = async (org: string) => {
  const { items } = await auditLog(on, org, { op: 'audit_read' });
  return (items as Json[]).filter((row) => row.source.startsWith('repo:')).reverse();
};
const kinds = (rows: Json[]) => rows.map((row) => row.kind);
/** Rows waiting in the repository: every `hook_outbox` row, with no hook set up. */
const waiting = (repo: string) =>
  runInDurableObject(
    bindings.SOURCE_REPOS.get(bindings.SOURCE_REPOS.idFromName(repo)),
    (_, state) =>
      state.storage.sql.exec<{ n: number }>('SELECT COUNT(*) AS n FROM hook_outbox').one().n,
  );

/** One of each change, as `target` has them. */
async function everyAction(auth: Auth, id: string, target: Env) {
  const steps: [string, { method?: string; body?: unknown }][] = [
    [`/repos/${id}/visibility`, { method: 'PUT', body: { visibility: 'public' } }],
    [`/repos/${id}/name`, { method: 'PUT', body: { name: 'renamed' } }],
    [`/repos/${id}/members`, { body: { account: 'audit_mate', role: 'write' } }],
    [`/repos/${id}/members/audit_mate`, { method: 'DELETE' }],
    [`/repos/${id}/tokens`, { body: { name: 'bot', scopes: ['read'] } }],
    [`/repos/${id}/tokens/bot`, { method: 'DELETE' }],
    [`/repos/${id}/policy`, { method: 'PUT', body: { policy: { required_checks: ['unit'], approvals: 2 } } }],
    [`/repos/${id}/retention`, { method: 'PUT', body: { keep_versions: 100, keep_days: 10 } }],
  ];
  for (const [path, init] of steps)
    expect((await api(path, auth, init, target)).status, path).toBe(200);
  const hook = await api(`/repos/${id}/hooks`, auth, { body: { url: 'https://ci.example.com/hook/tok3n?key=abc' } }, target);
  expect(hook.status).toBe(200);
  await api(`/repos/${id}/hooks/${hook.body.id}`, auth, { method: 'DELETE' }, target);
}

it('off writes nothing, and nothing a client sends turns it on', async () => {
  const alice = { cookie: await signup('audit_off') };
  await signup('audit_mate');
  await api('/orgs', alice, { body: { name: 'acme' } });
  const id = await makeRepo(alice, 'acme', 'app', scoped);
  await everyAction(alice, id, scoped);
  await caller(scoped, id, { _system: 'purge' })({ op: 'repo_hold_owner', _audit: 'on' });
  const signed = caller(scoped, id, { _anonymous: true }).sign({ op: 'repo_status', _audit: 'on' });
  expect(signed._audit).toBeUndefined();
  await api(`/repos/${id}/members`, alice, { body: { account: 'audit_mate', role: 'read', _audit: 'on' } });
  await api(`/repos/${id}?confirm=renamed`, alice, { method: 'DELETE' });
  expect(await waiting(id)).toBe(0);
  expect((await auditLog(scoped, 'acme', { op: 'audit_read' })).items).toEqual([]);
});

it('each change reaches the org log once, with its actor and allow-listed details', async () => {
  const alice = { cookie: await signup('audit_owner') };
  await signup('audit_mate');
  await makeOrg(alice, 'acme');
  const id = await makeRepo(alice, 'acme');
  await everyAction(alice, id, on);
  await api(`/repos/${id}?confirm=renamed`, alice, { method: 'DELETE' }, undo);
  await api(`/repos/${id}/restore`, alice, { body: { name: 'back' } }, undo);

  const rows = await repoRows('acme');
  expect(kinds(rows)).toEqual([
    'repo.created',
    'repo.visibility_changed',
    'repo.renamed',
    'repo.member_put',
    'repo.member_removed',
    'repo.token_created',
    'repo.token_revoked',
    'repo.policy_changed',
    'repo.retention_changed',
    'webhook.created',
    'webhook.deleted',
    'repo.deleted',
    'repo.restored',
  ]);
  for (const row of rows) {
    expect(row.actor, row.kind).toBe('user:audit_owner');
    expect(row.source, row.kind).toBe(`repo:${id}`);
    expect(row.details.repo, row.kind).toBe(id);
  }
  const details = (kind: string) => rows.find((row) => row.kind === kind)?.details;
  expect(details('repo.created')).toEqual({ repo: id, name: 'app', visibility: 'private' });
  expect(details('repo.renamed')).toEqual({ repo: id, name: 'renamed', previous: 'app' });
  expect(details('repo.member_put')).toEqual({ repo: id, name: 'renamed', account: 'audit_mate', role: 'write' });
  expect(details('repo.token_created')).toEqual({ repo: id, name: 'renamed', token: 'bot', scopes: ['read'] });
  expect(details('repo.policy_changed')).toMatchObject({ required_checks: ['unit'], approvals: 2 });
  expect(details('repo.retention_changed')).toMatchObject({ keep_versions: 100, keep_days: 10 });
  expect(details('webhook.created')).toMatchObject({ host: 'ci.example.com' });
  expect(details('repo.restored')).toEqual({ repo: id, name: 'back', previous: 'renamed' });
  expect(JSON.stringify(rows)).not.toContain('tok3n');
  expect(await waiting(id)).toBe(0);

  // Rows chain with the org's own, and read as any others do.
  expect((await api('/orgs/acme/audit/verify', alice, {}, on)).body.ok).toBe(true);
  const filtered = await api('/orgs/acme/audit?kind=repo.renamed', alice, {}, on);
  expect(kinds(filtered.body.items)).toEqual(['repo.renamed']);
  const mine = await api('/orgs/acme/audit?actor=audit_owner', alice, {}, on);
  expect(kinds(mine.body.items)).toContain('repo.restored');
});

it("an account's token acts as the account", async () => {
  const alice = { cookie: await signup('audit_tokens') };
  await makeOrg(alice, 'acme');
  const id = await makeRepo(alice, 'acme');
  const made = await api('/tokens', alice, { body: { name: 'ci', scopes: ['repo:admin'], org: 'acme', expires_days: 1 } }, on);
  const admin = { token: made.body.token as string };
  expect((await api(`/repos/${id}/tokens`, admin, { body: { name: 'bot', scopes: ['read'] } }, on)).status).toBe(200);
  const row = (await repoRows('acme')).find((r) => r.kind === 'repo.token_created');
  expect(row?.actor).toBe('user:audit_tokens');
});

it('a fork and an import are creates, and a fork names its parent', async () => {
  const alice = { cookie: await signup('audit_forks') };
  await makeOrg(alice, 'acme');
  const workflows = { create: async (options: any) => ({ id: options.id }) };
  const target = { ...on, PLATFORM_IMPORT: workflows } as unknown as Env;
  const parent = await makeRepo(alice, 'acme', 'app', target);
  await drainObjects(target);
  const forked = await api(`/repos/${parent}/fork`, alice, { body: { name: 'mine', owner: 'acme', policy } }, target);
  expect(forked.status, JSON.stringify(forked.body)).toBe(200);
  const imported = await api('/repos/import', alice, { body: { name: 'pulled', owner: 'acme', url: 'https://github.com/acme/src.git', branch: 'main' } }, target);
  expect(imported.status, JSON.stringify(imported.body)).toBe(200);
  const rows = await repoRows('acme');
  expect(rows.map((r) => r.details.name)).toEqual(['app', 'mine', 'pulled']);
  expect(rows[1].details).toMatchObject({ repo: forked.body.id, parent });
  expect(rows[2].details.repo).toBe(imported.body.id);
});

it('a failed action records nothing', async () => {
  const alice = { cookie: await signup('audit_fails') };
  const eve = { cookie: await signup('audit_eve') };
  await makeOrg(alice, 'acme');
  const id = await makeRepo(alice, 'acme');
  const refused: [string, Auth, { method?: string; body?: unknown }][] = [
    [`/repos/${id}?confirm=wrong`, alice, { method: 'DELETE' }],
    [`/repos/${id}/visibility`, alice, { method: 'PUT', body: { visibility: 'nope' } }],
    [`/repos/${id}/name`, alice, { method: 'PUT', body: { name: '.bad' } }],
    [`/repos/${id}/members`, alice, { body: { account: 'audit_nobody', role: 'read' } }],
    [`/repos/${id}/members/audit_eve`, alice, { method: 'DELETE' }],
    [`/repos/${id}/tokens`, alice, { body: { name: 'bad name!', scopes: ['read'] } }],
    [`/repos/${id}/policy`, alice, { method: 'PUT', body: { policy: 'nope' } }],
    [`/repos/${id}/retention`, alice, { method: 'PUT', body: { keep_versions: 1 } }],
    [`/repos/${id}/hooks`, alice, { body: { url: 'http://localhost/hook' } }],
    [`/repos/${id}/visibility`, eve, { method: 'PUT', body: { visibility: 'public' } }],
    [`/repos/${id}?confirm=app`, eve, { method: 'DELETE' }],
  ];
  for (const [path, who, init] of refused)
    expect((await api(path, who, init, on)).status, path).toBeGreaterThanOrEqual(400);
  expect(kinds(await repoRows('acme'))).toEqual(['repo.created']);
  expect(await waiting(id)).toBe(0);
});

it('a create that fails after the authority accepted it leaves nothing in the log', async () => {
  const alice = { cookie: await signup('audit_retry') };
  await makeOrg(alice, 'acme');
  const made = await api('/repos', alice, { body: { name: 'app', owner: 'acme', policy, tokens: [{ name: 'bad name!', scopes: ['read'] }] } }, on);
  expect(made.status).toBe(400);
  const job = queued.find((m) => m.kind === 'platform_purge');
  expect(job).toBeDefined();
  await purgeJob(on, job);
  expect(await repoRows('acme')).toEqual([]);
});

it("one org's repository never reaches another's log, nor a person's anyone's", async () => {
  const alice = { cookie: await signup('audit_alice') };
  const bob = { cookie: await signup('audit_bob') };
  await makeOrg(alice, 'acme');
  await makeOrg(bob, 'beta');
  const ours = await makeRepo(alice, 'acme', 'ours');
  const theirs = await makeRepo(bob, 'beta', 'theirs');
  const personal = await makeRepo(alice, null, 'own');
  await api(`/repos/${ours}/visibility`, alice, { method: 'PUT', body: { visibility: 'public' } }, on);
  await api(`/repos/${personal}/visibility`, alice, { method: 'PUT', body: { visibility: 'public' } }, on);

  const seen = async (org: string) => (await repoRows(org)).map((r) => [r.kind, r.details.repo]);
  expect(await seen('acme')).toEqual([
    ['repo.created', ours],
    ['repo.visibility_changed', ours],
  ]);
  expect(await seen('beta')).toEqual([['repo.created', theirs]]);
  // Only an owner of the org reads it: the rows carry no wider than the log does.
  expect((await api('/orgs/acme/audit', bob, {}, on)).status).toBe(403);
  // A person has no log: their repository's events go nowhere and don't pile up.
  expect((await auditLog(on, 'audit_alice', { op: 'audit_read' })).items).toEqual([]);
  expect(await waiting(personal)).toBe(0);
});

it('a failed copy fails nothing; events wait in the repository for the next', async () => {
  const alice = { cookie: await signup('audit_down') };
  await makeOrg(alice, 'acme');
  const id = await makeRepo(alice, 'acme');
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const put = await api(`/repos/${id}/visibility`, alice, { method: 'PUT', body: { visibility: 'public' } }, broken());
  expect(put.status).toBe(200);
  expect(warn).toHaveBeenCalled();
  expect(await waiting(id)).toBe(1);
  await api(`/repos/${id}/visibility`, alice, { method: 'PUT', body: { visibility: 'private' } }, on);
  expect(kinds(await repoRows('acme'))).toEqual([
    'repo.created',
    'repo.visibility_changed',
    'repo.visibility_changed',
  ]);
  expect(await waiting(id)).toBe(0);
});

it("a purge copies what is waiting: a repository's last event outlives the erase", async () => {
  const alice = { cookie: await signup('audit_purge') };
  await makeOrg(alice, 'acme');
  const id = await makeRepo(alice, 'acme');
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  await api(`/repos/${id}?confirm=app`, alice, { method: 'DELETE' }, broken());
  expect(await waiting(id)).toBe(1);
  await purgeJob(on, queued.find((m) => m.kind === 'platform_purge'));
  expect(kinds(await repoRows('acme'))).toEqual(['repo.created', 'repo.deleted']);
});

it("an owner's purge reaches the org log with who asked, before the repository goes", async () => {
  const alice = { cookie: await signup('audit_purge_now') };
  await makeOrg(alice, 'acme');
  const id = await makeRepo(alice, 'acme');
  await api(`/repos/${id}?confirm=app`, alice, { method: 'DELETE' }, undo);
  expect((await api(`/repos/${id}/purge`, alice, { body: {} }, undo)).status).toBe(200);
  const rows = await repoRows('acme');
  expect(kinds(rows)).toEqual(['repo.created', 'repo.deleted', 'repo.purge_requested']);
  expect(rows.at(-1)).toMatchObject({ actor: 'user:audit_purge_now', details: { repo: id, name: 'app' } });
});

it('copies run after the answer, so a slow log costs the action nothing', async () => {
  const alice = { cookie: await signup('audit_slow') };
  await makeOrg(alice, 'acme');
  const id = await makeRepo(alice, 'acme');
  const later: Promise<unknown>[] = [];
  const put = await withWaitUntil(
    (work) => later.push(work),
    () => api(`/repos/${id}/visibility`, alice, { method: 'PUT', body: { visibility: 'public' } }, on),
  );
  expect(put.status).toBe(200);
  expect(later.length).toBeGreaterThan(0);
  await Promise.all(later);
  expect(kinds(await repoRows('acme'))).toContain('repo.visibility_changed');
});

it('forced landings and the other break-glass actions reach the log, once each, with the reason', async () => {
  const alice = { cookie: await signup('audit_glass') };
  await makeOrg(alice, 'acme');
  const gates = { required_checks: ['unit'], approvals: 1, runners: { unit: { command: ['true'], timeout_seconds: 30 } } };
  const created = await api('/repos', alice, { body: { name: 'app', owner: 'acme', policy: gates, files: [file('a.md', 'a\n')], author } }, on);
  expect(created.status, JSON.stringify(created.body)).toBe(200);
  const id = created.body.id as string;
  const made = await api(`/repos/${id}/commits`, alice, { body: { ref: 'main', changes: [file('a.md', 'b\n')], message: 'two', author } }, on);
  const land = { action: 'land', ref: 'main', commit: made.body.commit, expected_old: created.body.commit, reason: 'the runner is down' };
  const forced = await api(`/repos/${id}/break-glass`, alice, { body: land }, on);
  expect(forced.status, JSON.stringify(forced.body)).toBe(200);
  // A retry is the same landing, and the same row.
  expect((await api(`/repos/${id}/break-glass`, alice, { body: land }, on)).body.already).toBe(true);
  await api(`/repos/${id}/break-glass`, alice, { body: { action: 'pause_automation', reason: 'hold on' } }, on);
  const rows = (await repoRows('acme')).filter((row) => row.kind === 'repo.break_glass');
  expect(rows.map((row) => row.details.action)).toEqual(['land', 'pause_automation']);
  expect(rows[0].actor).toBe('user:audit_glass');
  expect(rows[0].details).toMatchObject({ repo: id, name: 'app', ref: 'refs/heads/main', commit: made.body.commit, reason: 'the runner is down' });
  expect(await waiting(id)).toBe(0);
});

it('off, a forced landing records nothing', async () => {
  const alice = { cookie: await signup('audit_glass_off') };
  await api('/orgs', alice, { body: { name: 'acme' } }, scoped);
  const id = (await api('/repos', alice, { body: { name: 'app', owner: 'acme', policy, files: [file('a.md', 'a\n')], author } }, scoped)).body.id as string;
  const paused = await api(`/repos/${id}/break-glass`, alice, { body: { action: 'pause_automation', reason: 'hold on' } }, scoped);
  expect(paused.status, JSON.stringify(paused.body)).toBe(200);
  expect(await waiting(id)).toBe(0);
  expect((await auditLog(scoped, 'acme', { op: 'audit_read' })).items).toEqual([]);
});

it('a webhook switched off for its failures reaches the log, from a tombstone too', async () => {
  const alice = { cookie: await signup('audit_hook') };
  await makeOrg(alice, 'acme');
  const id = await makeRepo(alice, 'acme');
  const hook = await api(`/repos/${id}/hooks`, alice, { body: { url: 'https://ci.example.com/hook/tok3n?key=abc', events: ['repo'] } }, on);
  expect(hook.status, JSON.stringify(hook.body)).toBe(200);
  await runInDurableObject(bindings.SOURCE_REPOS.get(bindings.SOURCE_REPOS.idFromName(id)), (_, state) => {
    state.storage.sql.exec('UPDATE hooks SET failures=49');
  });
  await api(`/repos/${id}?confirm=app`, alice, { method: 'DELETE' }, on);
  await deliverHook(on, id, hook.body.id, async () => new Response('no', { status: 500 }));
  const row = (await repoRows('acme')).at(-1);
  expect(row?.kind).toBe('webhook.disabled');
  expect(row?.actor).toBe('platform:hooks');
  expect(row?.details).toMatchObject({ repo: id, id: String(hook.body.id), host: 'ci.example.com' });
  expect(JSON.stringify(row)).not.toContain('tok3n');
});
