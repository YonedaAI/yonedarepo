// An orphan: a live repository whose org is gone, so nobody can delete it and purge-now refuses
// it as not deleted. An operator purges exactly that, through the real authorities, D1 and R2.
// The org here retires as the race before it was closed left one: past the adapter's checks.
import { expect, it } from 'vitest';
import { platformJob } from '../../cloudflare/worker/platform-entrypoint';
import { forgetOrgAccess } from '../../cloudflare/worker/platform-org-access';
import type { Env } from '../../cloudflare/worker/types';
import { workspace } from '../../cloudflare/worker/workspace';
import { api, author, bindings, drainObjects, file, queued, scoped, signup, usePlatformFixture } from './repo-fixture';

usePlatformFixture();

const off = { ...scoped, PLATFORM_OBJECT_STORE: 'r2', ARTIFACTS: undefined, ADMIN_ACCOUNTS: 'orphan_ops' } as unknown as Env;
const on = { ...off, REPO_UNDO_DAYS: '30' } as unknown as Env;
const holds = { ...off, LEGAL_HOLD: 'on' } as unknown as Env;
const OPEN = { required_checks: [], approvals: 0 };

const operator = async () => ({ cookie: await signup('orphan_ops') });
const path = (id: string) => `/admin/repos/${id}/purge-orphan`;
const stored = async (id: string) =>
  (await bindings.OBJECTS.list({ prefix: `platform/v1/${id}/` })).objects.length;
const listing = (id: string) =>
  bindings.INDEX.prepare('SELECT workspace,name FROM platform_repos WHERE id=?').bind(id).first<any>();
const audited = async (action: string) => {
  const rows = await bindings.INDEX.prepare('SELECT actor,target FROM admin_audit WHERE action=?').bind(action).all();
  return rows.results;
};

async function seeded(who: { cookie?: string; token?: string }, name: string, target: Env, owner: Record<string, string> = {}) {
  const created = await api('/repos', who, { body: { name, policy: OPEN, files: [file('a.txt', 'a\n')], author, ...owner } }, target);
  expect(created.status, JSON.stringify(created.body)).toBe(200);
  await drainObjects(target);
  return created.body.id as string;
}

/** A repository of an org that was then deleted: `name`, its id, and who owned it. */
async function orphan(target: Env, label = 'orphan_owner') {
  const who = { cookie: await signup(label) };
  const org = `${label}_org`;
  expect((await api('/orgs', who, { body: { name: org } }, target)).status).toBe(200);
  const name = 'left';
  const id = await seeded(who, name, target, { owner: org });
  await workspace(target, org, { op: 'owned_repo_release', repo: id });
  await workspace(target, org, { op: 'org_delete', actor: label, confirm: org, _hold: 'off' });
  forgetOrgAccess(org);
  expect((await api(`/repos/${id}?confirm=${name}`, who, { method: 'DELETE' }, target)).status).toBe(404);
  return { id, name, who, org };
}

async function deliverPurges(id: string, target: Env) {
  const jobs = queued.filter((m) => m.kind === 'platform_purge' && m.repo_id === id);
  queued.splice(0, queued.length, ...queued.filter((m) => !jobs.includes(m)));
  for (const body of jobs)
    await platformJob(target, { body, attempts: 2, ack: () => {}, retry: () => {} } as unknown as Message<any>);
  return jobs.length;
}

it.each([
  ['with no undo window', off],
  ['with an undo window', on],
])('purges a repository whose org is gone, %s, as its own audited action', async (_, target) => {
  const ops = await operator();
  const { id, name, who, org } = await orphan(target);
  expect(await stored(id)).toBeGreaterThan(0);

  // Purge-now is what it was, and nobody but an operator gets this.
  expect((await api(`/admin/repos/${id}/purge-now`, ops, { body: {} }, target)).status).toBe(409);
  expect((await api(path(id), who, { body: { confirm: name } }, target)).status).toBe(403);
  const unnamed = await api(path(id), ops, { body: {} }, target);
  expect([unnamed.status, unnamed.body.error.code]).toEqual([400, 'INVALID_INPUT']);
  const misnamed = await api(path(id), ops, { body: { confirm: 'other' } }, target);
  expect([misnamed.status, misnamed.body.error.code]).toEqual([400, 'INVALID_INPUT']);
  expect(await listing(id)).not.toBeNull();

  const done = await api(path(id), ops, { body: { confirm: name } }, target);
  expect(done.status, JSON.stringify(done.body)).toBe(200);
  expect(done.body).toEqual({ queued: true });
  expect(await listing(id)).toBeNull();
  expect(await deliverPurges(id, target)).toBeGreaterThan(0);
  expect(await stored(id)).toBe(0);
  const scheduled = await bindings.INDEX.prepare('SELECT id FROM platform_deleted_repos WHERE id=?').bind(id).first();
  expect(scheduled).toBeNull();

  const rows = await audited('repo.purge_orphan');
  expect(rows).toContainEqual({ actor: 'orphan_ops', target: id });
  const last = await bindings.INDEX.prepare("SELECT detail FROM admin_audit WHERE action='repo.purge_orphan' ORDER BY id DESC").first<any>();
  expect(JSON.parse(last.detail)).toEqual({ owner: org, queued: true });
  expect(await audited('repo.purge_now')).toEqual([]);

  // Once more after a lost answer: nothing to do, and no failure.
  expect((await api(path(id), ops, { body: { confirm: name } }, target)).status).toBe(200);
});

it('refuses every repository with an owner that is alive or was never known to be gone', async () => {
  const ops = await operator();
  const who = { cookie: await signup('orphan_person') };
  expect((await api('/orgs', who, { body: { name: 'orphan_live_org' } }, off)).status).toBe(200);
  const person = await seeded(who, 'mine', off);
  const org = await seeded(who, 'ours', off, { owner: 'orphan_live_org' });
  // An operator's workspace has no account record: not one that is proved gone.
  const provisioned = await seeded({ token: 'local-test-owner' }, 'theirs', off, { workspace: 'orphan_provisioned' });

  for (const [id, name] of [[person, 'mine'], [org, 'ours'], [provisioned, 'theirs']]) {
    const refused = await api(path(id), ops, { body: { confirm: name } }, off);
    expect([refused.status, refused.body.error.code]).toEqual([409, 'CONFLICT']);
    expect(await listing(id)).not.toBeNull();
    expect(await stored(id)).toBeGreaterThan(0);
  }
  expect((await api(path('r00000000000000000000'), ops, { body: { confirm: 'x' } }, off)).status).toBe(404);
  expect(queued.filter((m) => m.kind === 'platform_purge')).toEqual([]);
  expect(await audited('repo.purge_orphan')).toEqual([]);
});

it('refuses under a legal hold, whatever the switch says, until the hold is lifted', async () => {
  const ops = await operator();
  const { id, name } = await orphan(holds);
  expect((await api(`/admin/repos/${id}/hold`, ops, { body: {} }, holds)).status).toBe(200);

  for (const target of [holds, off]) {
    const refused = await api(path(id), ops, { body: { confirm: name } }, target);
    expect([refused.status, refused.body.error.code]).toEqual([423, 'LEGAL_HOLD']);
  }
  expect(await listing(id)).not.toBeNull();
  expect(await stored(id)).toBeGreaterThan(0);
  expect(await audited('repo.purge_orphan')).toEqual([]);

  expect((await api(`/admin/repos/${id}/hold`, ops, { method: 'DELETE' }, holds)).status).toBe(200);
  expect((await api(path(id), ops, { body: { confirm: name } }, holds)).status).toBe(200);
  expect(await listing(id)).toBeNull();
});
