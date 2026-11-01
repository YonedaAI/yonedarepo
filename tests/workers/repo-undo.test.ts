// The undo window through the real authorities, D1 and R2 (workerd), with REPO_UNDO_DAYS set: a
// deletion answers and reads as it always did, but the purge waits for the sweep to find it
// due, and until a purge starts the owner can restore it, reads, clones and all. The authority
// decides (`purge_target` refuses until due); a job that comes early, late or after a restore
// settles quietly. Unset, nothing here happens.
import { runInDurableObject } from 'cloudflare:test';
import { expect, it, vi } from 'vitest';
import { toolsOf } from '../../cloudflare/worker/account-mcp';
import { platformJob } from '../../cloudflare/worker/platform-entrypoint';
import { platformFetch } from '../../cloudflare/worker/platform-routes';
import { sweepDeleted } from '../../cloudflare/worker/repo-deleted';
import { purgeRepository } from '../../cloudflare/worker/repo-admin';
import { eraseJob } from '../../cloudflare/worker/repo-erase';
import { deliverHook } from '../../cloudflare/worker/repo-hooks';
import { caller } from '../../cloudflare/worker/repo-ops';
import { quarantineJob } from '../../cloudflare/worker/repo-quarantine';
import type { Env } from '../../cloudflare/worker/types';
import { workspace } from '../../cloudflare/worker/workspace';
import { api, author, bindings, drainObjects, fakeQueue, file, queued, scoped, signup, usePlatformFixture } from './repo-fixture';

usePlatformFixture();

const off = { ...scoped, PLATFORM_OBJECT_STORE: 'r2', ARTIFACTS: undefined, ADMIN_ACCOUNTS: 'undo_ops' } as unknown as Env;
const on = { ...off, REPO_UNDO_DAYS: '30' } as unknown as Env;
/** A window that has passed by the next line: the authority's clock is the real one. */
const short = { ...off, REPO_UNDO_DAYS: '0.000001' } as unknown as Env;
const OPEN = { required_checks: [], approvals: 0 };
const DAY = 86_400_000;
const del = { method: 'DELETE' };

const stored = async (prefix: string) => (await bindings.OBJECTS.list({ prefix })).objects.map((o) => o.key);

async function made(who: { cookie: string }, name: string, target: Env = on, owner?: string) {
  const created = await api('/repos', who, { body: { name, policy: OPEN, files: [file('a.txt', 'a\n')], author, owner, tokens: [{ name: 'agent', scopes: ['read', 'write'] }] } }, target);
  expect(created.status, JSON.stringify(created.body)).toBe(200);
  await drainObjects(target);
  return { id: created.body.id as string, commit: created.body.commit as string, token: created.body.tokens[0].token as string };
}
const remove = (who: { cookie: string }, id: string, name: string, target: Env = on) =>
  api(`/repos/${id}?confirm=${name}`, who, del, target);
const restore = (who: any, id: string, body: any = {}, target: Env = on) =>
  api(`/repos/${id}/restore`, who, { body }, target);
const purge = (who: any, id: string, target: Env = on) =>
  api(`/repos/${id}/purge`, who, { body: {} }, target);

/** Delivers one queued job as the queue does, reporting how it settled. */
async function deliver(body: any, target: Env = on) {
  let settled = 'unsettled';
  await platformJob(target, { body, attempts: 2, ack: () => void (settled = 'ack'), retry: () => void (settled = 'retry') } as unknown as Message<any>);
  return settled;
}
const purges = (repo?: string) => queued.filter((m) => m.kind === 'platform_purge' && (!repo || m.repo_id === repo));
const row = (id: string) =>
  bindings.INDEX.prepare('SELECT * FROM platform_deleted_repos WHERE id=?').bind(id).first<any>();
/** Runs every queued purge of `repo`. */
async function runPurges(repo: string, target: Env = on) {
  const jobs = purges(repo);
  queued.splice(0, queued.length, ...queued.filter((m) => !jobs.includes(m)));
  return Promise.all(jobs.map((job) => deliver(job, target)));
}
/** The sweep at `days` from now, and what it sent. */
async function sweep(days: number, target: Env = on) {
  queued.length = 0;
  await sweepDeleted(target, Date.now() + days * DAY);
  return purges();
}
/** Waits out a `short` window and has the sweep send `repo`'s purge. */
async function purgeDue(repo: string, target: Env = short) {
  await new Promise((resolve) => setTimeout(resolve, 150));
  await sweep(0, target);
  return purges(repo);
}

it('a deletion answers as ever, and the purge waits', async () => {
  const cookie = await signup('undo_wait');
  const who = { cookie };
  const { id, token } = await made(who, 'kept');
  const before = await stored(`platform/v1/${id}/`);
  expect(before.length).toBeGreaterThan(0);

  const deleted = await remove(who, id, 'kept');
  expect([deleted.status, deleted.body]).toEqual([200, { deleted: true }]);
  expect(purges(id)).toEqual([]);
  for (const path of [`/repos/${id}`, `/repos/${id}/refs`]) {
    const gone = await api(path, who, {}, on);
    expect([gone.status, gone.body.error.code]).toEqual([404, 'GONE']);
  }
  expect((await api(`/repos/${id}/refs`, { token }, {}, on)).body.error.code).toBe('GONE');
  expect((await api('/repos', who, {}, on)).body.repos).toEqual([]);

  const listed = (await api('/repos/deleted', who, {}, on)).body;
  expect(listed.window_days).toBe(30);
  expect(listed.repos).toHaveLength(1);
  const entry = listed.repos[0];
  expect(entry).toMatchObject({ id, name: 'kept', owner: 'undo_wait', visibility: 'private' });
  expect(entry.purge_at).toBe(entry.deleted_at + 30 * DAY);
  // D1 is a projection: the owner's authority holds the entry.
  const records = await workspace(on, 'undo_wait', { op: 'deleted_repo_list' });
  expect(records.repos).toEqual([expect.objectContaining({ repo: id, name: 'kept', purge_at: entry.purge_at })]);

  expect(await sweep(29)).toEqual([]);
  expect(await stored(`platform/v1/${id}/`)).toEqual(before);
  // The name is free meanwhile.
  expect((await api('/repos', who, { body: { name: 'kept' } }, on)).status).toBe(200);
});

it('restores with reads, clones, members and the original date back, tokens still revoked', async () => {
  const who = { cookie: await signup('undo_back') };
  const friend = { cookie: await signup('undo_friend') };
  const { id, commit, token } = await made(who, 'back');
  expect((await api(`/repos/${id}/members`, who, { body: { account: 'undo_friend', role: 'read' } }, on)).status).toBe(200);
  const was = await bindings.INDEX.prepare('SELECT created_at,visibility FROM platform_repos WHERE id=?').bind(id).first<any>();
  await remove(who, id, 'back');
  await new Promise((resolve) => setTimeout(resolve, 5));
  queued.length = 0;

  const restored = await restore(who, id);
  expect(restored.status, JSON.stringify(restored.body)).toBe(200);
  expect(restored.body).toMatchObject({ id, name: 'back', restored: true, path: '/undo_back/back' });

  expect((await api(`/repos/${id}/refs`, who, {}, on)).body.refs['refs/heads/main']).toBe(commit);
  expect((await api(`/repos/${id}/blob?path=a.txt`, who, {}, on)).status).toBe(200);
  const listed = (await api('/repos', who, {}, on)).body.repos;
  expect(listed).toEqual([expect.objectContaining({ id, name: 'back' })]);
  const now = await bindings.INDEX.prepare('SELECT created_at,visibility FROM platform_repos WHERE id=?').bind(id).first<any>();
  expect(now.visibility).toBe(was.visibility);
  expect(Math.abs(now.created_at - was.created_at)).toBeLessThan(5_000);
  expect(now.created_at).toBeLessThan(Date.now() - 1);
  expect((await api('/repos', friend, {}, on)).body.repos.map((r: any) => r.id)).toEqual([id]);
  expect((await api('/repos/deleted', who, {}, on)).body.repos).toEqual([]);
  expect(await row(id)).toBeNull();
  expect((await workspace(on, 'undo_back', { op: 'deleted_repo_list' })).repos).toEqual([]);
  // Writing and Git work again; a token from before does not.
  const landed = await api(`/repos/${id}/commits`, who, { body: { parent: commit, changes: [file('b.txt', 'b\n')], message: 'b', author } }, on);
  expect(landed.status, JSON.stringify(landed.body)).toBe(200);
  const pat = (await api('/tokens', who, { body: { name: 'git', scopes: ['repo:read'] } }, on)).body.token as string;
  const advertised = await platformFetch(new Request(`https://yoneda/git/${id}.git/info/refs?service=git-upload-pack`, {
    headers: { authorization: `Basic ${btoa(`x:${pat}`)}` },
  }), on);
  expect(advertised.status).toBe(200);
  expect(await advertised.text()).toContain('refs/heads/main');
  expect((await api(`/repos/${id}/refs`, { token }, {}, on)).status).toBe(401);
  // Everything a deletion stopped is started again.
  expect(queued.map((m) => m.kind)).toEqual(expect.arrayContaining(['platform_project', 'platform_objects', 'platform_hooks', 'platform_quarantine', 'platform_lfs_sweep']));
  // The repository's name is held, so its readable path resolves.
  expect((await api('/resolve/undo_back/back', who, {}, on)).body.id).toBe(id);
});

it('asks for a new name when its own was taken, then takes it', async () => {
  const who = { cookie: await signup('undo_name') };
  const { id } = await made(who, 'taken');
  await remove(who, id, 'taken');
  await made(who, 'taken');
  const refused = await restore(who, id);
  expect([refused.status, refused.body.error.code]).toEqual([409, 'NAME_TAKEN']);
  expect(refused.body.error.message).toMatch(/new name/i);
  expect((await api(`/repos/${id}`, who, {}, on)).body.error.code).toBe('GONE');
  expect((await restore(who, id, { name: '.bad' })).status).toBe(400);
  const restored = await restore(who, id, { name: 'taken-again' });
  expect([restored.status, restored.body.name]).toEqual([200, 'taken-again']);
  expect((await api(`/repos/${id}`, who, {}, on)).body.name).toBe('taken-again');
  expect((await api('/resolve/undo_name/taken-again', who, {}, on)).body.id).toBe(id);
});

it('restores a fork only while its parent lives, and registers it with the parent again', async () => {
  const who = { cookie: await signup('undo_fork') };
  const { id: parent, commit } = await made(who, 'parent');
  const forked = await api(`/repos/${parent}/fork`, who, { body: { name: 'child' } }, on);
  expect(forked.status, JSON.stringify(forked.body)).toBe(200);
  const fork = forked.body.id as string;
  await remove(who, fork, 'child');

  // Its deletion freed the parent, and the restore counts it again.
  expect((await restore(who, fork)).status).toBe(200);
  expect((await api(`/repos/${fork}/blob?path=a.txt&ref=main`, who, {}, on)).status).toBe(200);
  const blocked = await remove(who, parent, 'parent');
  expect([blocked.status, blocked.body.error.code]).toEqual([409, 'CONFLICT']);

  await remove(who, fork, 'child');
  await remove(who, parent, 'parent');
  const orphan = await restore(who, fork);
  expect([orphan.status, orphan.body.error.code]).toEqual([409, 'CONFLICT']);
  expect(orphan.body.error.message).toMatch(/forked from/);
  expect((await api(`/repos/${fork}`, who, {}, on)).body.error.code).toBe('GONE');
  // Its name is not left held by the refused attempt.
  expect((await api('/repos', who, { body: { name: 'child' } }, on)).status).toBe(200);
  expect((await restore(who, parent)).status).toBe(200);
  expect((await api(`/repos/${parent}/refs`, who, {}, on)).body.refs['refs/heads/main']).toBe(commit);
  expect((await restore(who, fork, { name: 'child-2' })).status).toBe(200);
});

it('a repeated delete keeps the due time it promised', async () => {
  const who = { cookie: await signup('undo_twice') };
  const { id } = await made(who, 'twice');
  await remove(who, id, 'twice');
  const first = await row(id);
  await new Promise((resolve) => setTimeout(resolve, 5));
  expect((await remove(who, id, 'twice')).body).toEqual({ deleted: true });
  expect((await row(id)).purge_at).toBe(first.purge_at);
  expect(purges(id)).toEqual([]);
});

it('takes the window from the adapter alone', async () => {
  const signed = caller(on, 'r0123456789abcdef0123', { _session: { workspace: 'a', principal: 'user:a' } }).sign({ op: 'repo_purge_target', _undo_ms: 0 });
  expect(signed._undo_ms).toBe(30 * DAY);
  const unset = caller(off, 'r0123456789abcdef0123', { _session: { workspace: 'a', principal: 'user:a' } }).sign({ op: 'repo_purge_target', _undo_ms: 1 });
  expect(unset).not.toHaveProperty('_undo_ms');
});

it('a purge before its time is refused by the authority, whatever sent it', async () => {
  const who = { cookie: await signup('undo_early') };
  const { id } = await made(who, 'early');
  await remove(who, id, 'early');
  const keys = await stored(`platform/v1/${id}/`);
  for (const job_id of [`purge-${id}`, `due-${id}`])
    expect(await deliver({ v: 1, kind: 'platform_purge', repo_id: id, job_id })).toBe('ack');
  expect(await stored(`platform/v1/${id}/`)).toEqual(keys);
  const purge = caller(on, id, { _system: 'purge' });
  await expect(purge({ op: 'repo_purge_target' })).rejects.toMatchObject({ code: 'NOT_DUE' });
  // An erase is held back the same way.
  await eraseJob({ ...on, REPO_ERASE: 'on' } as unknown as Env, { v: 1, kind: 'platform_erase', repo_id: id, job_id: 'start' });
  expect(await stored(`platform/v1/${id}/`)).toEqual(keys);
  expect((await restore(who, id)).status).toBe(200);
});

it('a purge from before the switch puts the repository on the schedule', async () => {
  const who = { cookie: await signup('undo_turned') };
  const { id } = await made(who, 'caught', off);
  await remove(who, id, 'caught', off);
  const [job] = purges(id);
  expect(await row(id)).toBeNull();
  // The switch went on while the job waited: it is not lost, and not run early.
  expect(await deliver(job)).toBe('ack');
  expect((await stored(`platform/v1/${id}/`)).length).toBeGreaterThan(0);
  expect(await row(id)).toMatchObject({ workspace: 'undo_turned', name: 'caught' });
  expect((await api('/repos/deleted', who, {}, on)).body.repos).toHaveLength(1);
});

it('a purge arriving after a restore acknowledges quietly and leaves no entry', async () => {
  const who = { cookie: await signup('undo_late') };
  const { id } = await made(who, 'late', short);
  await remove(who, id, 'late', short);
  const jobs = await purgeDue(id);
  expect(jobs).toHaveLength(1);
  expect((await restore(who, id, {}, short)).status).toBe(200);
  expect(await deliver(jobs[0], short)).toBe('ack');
  expect(await deliver({ v: 1, kind: 'platform_purge', repo_id: id, job_id: `purge-${id}` }, short)).toBe('ack');
  expect((await stored(`platform/v1/${id}/`)).length).toBeGreaterThan(0);
  expect((await api(`/repos/${id}/refs`, who, {}, on)).status).toBe(200);
});

it('purges a due repository, fires repo.purged once and forgets it', async () => {
  const who = { cookie: await signup('undo_due') };
  const { id } = await made(who, 'due', short);
  const hook = await api(`/repos/${id}/hooks`, who, { body: { url: 'https://example.com/hook', events: ['repo'] } }, short);
  expect(hook.status, JSON.stringify(hook.body)).toBe(200);
  const sent: { event: string | null; body: any }[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const request = new Request(input as RequestInfo, init);
    sent.push({ event: request.headers.get('x-yoneda-event'), body: await request.json() });
    return new Response('ok');
  });
  await remove(who, id, 'due', short);
  await deliverHook(short, id, hook.body.id);
  expect(sent.map((s) => s.event)).toEqual(['repo.deleted']);
  expect(sent[0].body.purge_at).toBe(new Date((await row(id)).purge_at).toISOString());

  const jobs = await purgeDue(id);
  expect(jobs).toHaveLength(1);
  expect(await deliver(jobs[0], short)).toBe('ack');
  expect(await stored(`platform/v1/${id}/`)).toEqual([]);
  expect(await row(id)).toBeNull();
  expect((await workspace(short, 'undo_due', { op: 'deleted_repo_list' })).repos).toEqual([]);
  // Run again (at least once): the bytes stay gone and nothing fires twice.
  expect(await deliver(jobs[0], short)).toBe('ack');
  await deliverHook(short, id, hook.body.id);
  await deliverHook(short, id, hook.body.id);
  expect(sent.map((s) => s.event)).toEqual(['repo.deleted', 'repo.purged']);
  expect(queued.filter((m) => m.kind === 'platform_hooks' && m.repo_id === id).length).toBeGreaterThan(0);
  // Nothing brings it back.
  expect((await restore(who, id, {}, short)).body.error.code).toBe('GONE');
});

it('a restore loses to a purge that started first', async () => {
  const who = { cookie: await signup('undo_race') };
  const { id } = await made(who, 'race');
  await remove(who, id, 'race');
  await caller(on, id, { _system: 'purge', _undo_ms: 0 })({ op: 'repo_purge_target' });
  expect((await restore(who, id)).body.error.code).toBe('GONE');
});

it('the sweep sends a due purge once, small batches at a time, and looks again much later', async () => {
  const who = { cookie: await signup('undo_sweep') };
  const a = await made(who, 'a');
  const b = await made(who, 'b');
  await remove(who, a.id, 'a');
  await remove(who, b.id, 'b');
  expect((await sweep(29)).length).toBe(0);
  const first = await sweep(31);
  expect(first.map((m) => m.repo_id).sort()).toEqual([a.id, b.id].sort());
  expect(first.every((m) => m.job_id === `due-${m.repo_id}`)).toBe(true);
  expect((await sweep(31)).length).toBe(0);
  // A job lost after the send: its repository is still listed, so it goes again.
  expect((await sweep(32)).length).toBe(2);
  await bindings.INDEX.prepare('UPDATE platform_deleted_repos SET sent_at=0').run();
  expect((await sweep(33)).length).toBe(2);
});

it('takes back a failed create at once, window or not', async () => {
  const who = { cookie: await signup('undo_back_out') };
  const down = { ...on, PLATFORM_QUEUE: { ...fakeQueue, send: async (message: any) => {
    if (message.kind === 'platform_project') throw new Error('internal error; reference = abc123');
    return fakeQueue.send(message);
  } } } as unknown as Env;
  const refused = await api('/repos', who, { body: { name: 'failed', files: [file('a.txt', 'a\n')], author } }, down);
  expect(refused.status).toBe(503);
  const [job] = purges();
  expect(job.job_id).toMatch(/^now-r/);
  expect(await row(job.repo_id)).toBeNull();
  expect(await deliver(job)).toBe('ack');
  expect(await stored(`platform/v1/${job.repo_id}/`)).toEqual([]);
});

it('unset, a deletion purges at once and nothing is listed', async () => {
  const who = { cookie: await signup('undo_off') };
  const { id } = await made(who, 'plain', off);
  expect((await remove(who, id, 'plain', off)).body).toEqual({ deleted: true });
  expect(purges(id).map((m) => m.job_id)).toEqual([`purge-${id}`]);
  expect(await row(id)).toBeNull();
  expect((await api('/repos/deleted', who, {}, off)).body).toEqual({ window_days: 0, repos: [] });
  expect(await runPurges(id, off)).toEqual(['ack']);
  expect(await stored(`platform/v1/${id}/`)).toEqual([]);
  expect((await restore(who, id, {}, off)).status).toBe(404);
});

it('a rollback to unset keeps every promise made while it was on', async () => {
  const who = { cookie: await signup('undo_rollback') };
  const kept = await made(who, 'kept');
  const back = await made(who, 'back');
  await remove(who, kept.id, 'kept');
  await remove(who, back.id, 'back');
  // Not purged early, or lost: the sweep still runs and keeps the due time it promised.
  expect((await sweep(29, off)).length).toBe(0);
  expect((await api('/repos/deleted', who, {}, off)).body.repos).toHaveLength(2);
  expect((await restore(who, back.id, {}, off)).status).toBe(200);
  const jobs = await sweep(31, off);
  expect(jobs.map((m) => m.repo_id)).toEqual([kept.id]);
  expect(await deliver(jobs[0], off)).toBe('ack');
  expect(await stored(`platform/v1/${kept.id}/`)).toEqual([]);
  expect(await row(kept.id)).toBeNull();
});

it('a hold freezes the purge of a due repository, and restoring it is allowed', async () => {
  const held = { ...short, LEGAL_HOLD: 'on' } as unknown as Env;
  const owner = { cookie: await signup('undo_holder') };
  const org = 'undo_held_org';
  expect((await api('/orgs', owner, { body: { name: org } }, held)).status).toBe(200);
  const { id } = await made(owner, 'held', held, org);
  await remove(owner, id, 'held', held);
  expect((await api(`/orgs/${org}/hold`, owner, { body: {} }, held)).status).toBe(200);
  const jobs = await purgeDue(id, held);
  expect(jobs).toHaveLength(1);
  expect(await deliver(jobs[0], held)).toBe('ack');
  expect((await stored(`platform/v1/${id}/`)).length).toBeGreaterThan(0);
  expect(queued.filter((m) => m.kind === 'platform_purge').length).toBe(1);
  expect(await row(id)).not.toBeNull();
  // Its org cannot go either, though it owns nothing that is listed.
  const org_delete = await api(`/orgs/${org}?confirm=${org}`, owner, del, held);
  expect([org_delete.status, org_delete.body.error.code]).toEqual([423, 'LEGAL_HOLD']);
  // Not even an operator skips it.
  const operator = { cookie: await signup('undo_ops') };
  const refused = await api(`/admin/repos/${id}/purge-now`, operator, { body: {} }, held);
  expect([refused.status, refused.body.error.code]).toEqual([423, 'LEGAL_HOLD']);
  expect((await stored(`platform/v1/${id}/`)).length).toBeGreaterThan(0);
  expect((await restore(owner, id, {}, held)).status).toBe(200);
  expect((await api(`/repos/${id}/refs`, owner, {}, held)).status).toBe(200);
});

it('an operator purges now, audited, and nobody else can', async () => {
  const who = { cookie: await signup('undo_operated') };
  const operator = { cookie: await signup('undo_ops') };
  const { id } = await made(who, 'now');
  const path = `/admin/repos/${id}/purge-now`;
  expect((await api(path, operator, { body: {} }, on)).status).toBe(409);
  await remove(who, id, 'now');
  expect((await api(path, who, { body: {} }, on)).status).toBe(403);
  queued.length = 0;
  const done = await api(path, operator, { body: {} }, on);
  expect([done.status, done.body.queued]).toEqual([200, true]);
  const jobs = purges(id);
  expect(jobs.map((m) => m.job_id)).toEqual([`now-${id}`]);
  expect(await deliver(jobs[0])).toBe('ack');
  expect(await stored(`platform/v1/${id}/`)).toEqual([]);
  expect(await row(id)).toBeNull();
  const audited = await bindings.INDEX.prepare("SELECT actor,target FROM admin_audit WHERE action='repo.purge_now'").first<any>();
  expect(audited).toEqual({ actor: 'undo_ops', target: id });
  // Once more after teardown raced it: nothing to do, and no failure.
  expect((await api(path, operator, { body: {} }, on)).status).toBe(200);
});

it('its owner purges it now: the row goes at once, nothing restores it, and it is audited', async () => {
  const who = { cookie: await signup('undo_purged') };
  const { id } = await made(who, 'forever');
  await remove(who, id, 'forever');
  queued.length = 0;

  const done = await purge(who, id);
  expect([done.status, done.body]).toEqual([200, { purged: true }]);
  // Before any job has run: the list has dropped it and the mark has beaten a restore.
  expect((await api('/repos/deleted', who, {}, on)).body.repos).toEqual([]);
  const refused = await restore(who, id);
  expect([refused.status, refused.body.error.code]).toEqual([404, 'GONE']);
  expect((await stored(`platform/v1/${id}/`)).length).toBeGreaterThan(0);

  const jobs = purges(id);
  expect(jobs.map((m) => m.job_id)).toEqual([`now-${id}`]);
  expect(await deliver(jobs[0])).toBe('ack');
  expect(await stored(`platform/v1/${id}/`)).toEqual([]);
  expect(await row(id)).toBeNull();
  expect((await workspace(on, 'undo_purged', { op: 'deleted_repo_list' })).repos).toEqual([]);
  expect((await restore(who, id)).body.error.code).toBe('GONE');

  const audited = await bindings.INDEX.prepare("SELECT actor,target,detail FROM admin_audit WHERE action='repo.purge_owner'").first<any>();
  expect(audited).toMatchObject({ actor: 'undo_purged', target: id });
  expect(JSON.parse(audited.detail)).toMatchObject({ name: 'forever', owner: 'undo_purged', queued: true });
  // Its name was free already, and stays so.
  expect((await made(who, 'forever')).id).not.toBe(id);
});

it('only its owner purges it', async () => {
  const who = { cookie: await signup('undo_mine') };
  const admin = { cookie: await signup('undo_admin') };
  const stranger = { cookie: await signup('undo_stranger') };
  const { id } = await made(who, 'mine');
  const other = await made(who, 'other');
  expect((await api(`/repos/${id}/members`, who, { body: { account: 'undo_admin', role: 'admin' } }, on)).status).toBe(200);
  const issue = async (name: string, grant: any) =>
    ({ token: (await api('/tokens', who, { body: { name, ...grant } }, on)).body.token as string });
  const reader = await issue('reader', { scopes: ['repo:read'] });
  const elsewhere = await issue('elsewhere', { scopes: ['repo:admin'], repos: [other.id] });
  const adminToken = await issue('admin', { scopes: ['repo:admin'] });

  const live = await purge(who, id);
  expect([live.status, live.body.error.code]).toEqual([409, 'CONFLICT']);
  await remove(who, id, 'mine');
  queued.length = 0;
  for (const [caller_, status] of [[admin, 404], [stranger, 404], [reader, 403], [elsewhere, 403]] as const)
    expect((await purge(caller_, id)).status, JSON.stringify(caller_)).toBe(status);
  expect(purges(id)).toEqual([]);
  expect((await api('/repos/deleted', who, {}, on)).body.repos).toHaveLength(1);
  // Nothing they sent got in the way of a restore, or of a token that may.
  expect((await restore(who, id)).status).toBe(200);
  await remove(who, id, 'mine');
  expect((await purge(adminToken, id)).status).toBe(200);
});

it('a repository under a legal hold is refused with the reason, and still restores', async () => {
  const held = { ...on, LEGAL_HOLD: 'on' } as unknown as Env;
  const owner = { cookie: await signup('undo_purge_held') };
  const org = 'undo_purge_held_org';
  expect((await api('/orgs', owner, { body: { name: org } }, held)).status).toBe(200);
  const { id } = await made(owner, 'held', held, org);
  await remove(owner, id, 'held', held);
  expect((await api(`/orgs/${org}/hold`, owner, { body: {} }, held)).status).toBe(200);
  queued.length = 0;

  const refused = await purge(owner, id, held);
  expect([refused.status, refused.body.error.code]).toEqual([423, 'LEGAL_HOLD']);
  expect(refused.body.error.message).toMatch(/legal hold/);
  expect(purges(id)).toEqual([]);
  expect((await api(`/orgs/${org}/repos/deleted`, owner, {}, held)).body.repos).toHaveLength(1);
  expect((await stored(`platform/v1/${id}/`)).length).toBeGreaterThan(0);
  expect((await restore(owner, id, {}, held)).status).toBe(200);
});

it('a repeated purge is safe, whenever it comes', async () => {
  const who = { cookie: await signup('undo_again') };
  const { id } = await made(who, 'again');
  const hook = await api(`/repos/${id}/hooks`, who, { body: { url: 'https://example.com/hook', events: ['repo'] } }, on);
  const sent: (string | null)[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    sent.push(new Request(input as RequestInfo, init).headers.get('x-yoneda-event'));
    return new Response('ok');
  });
  await remove(who, id, 'again');
  await deliverHook(on, id, hook.body.id);
  queued.length = 0;

  expect((await purge(who, id)).status).toBe(200);
  expect((await purge(who, id)).status).toBe(200);
  const jobs = purges(id);
  expect(jobs).toHaveLength(2);
  expect(await Promise.all(jobs.map((job) => deliver(job)))).toEqual(['ack', 'ack']);
  await deliverHook(on, id, hook.body.id);
  await deliverHook(on, id, hook.body.id);
  expect(sent).toEqual(['repo.deleted', 'repo.purged']);
  expect(await row(id)).toBeNull();

  // Long after it finished: the same answer, and nothing to send.
  queued.length = 0;
  const later = await purge(who, id);
  expect([later.status, later.body]).toEqual([200, { purged: true }]);
  expect(purges(id)).toEqual([]);
  expect(await row(id)).toBeNull();
  expect((await workspace(on, 'undo_again', { op: 'deleted_repo_list' })).repos).toEqual([]);
});

it('a purge whose job was lost is sent again by the sweep', async () => {
  const who = { cookie: await signup('undo_lost_job') };
  const { id } = await made(who, 'lost');
  await remove(who, id, 'lost');
  expect((await purge(who, id)).status).toBe(200);
  // Not a day of this window has passed, and the job it just sent has time to run.
  expect(await sweep(0.1)).toEqual([]);
  const jobs = await sweep(0.5);
  expect(jobs.map((m) => m.job_id)).toEqual([`due-${id}`]);
  expect(await deliver(jobs[0])).toBe('ack');
  expect(await stored(`platform/v1/${id}/`)).toEqual([]);
  expect(await row(id)).toBeNull();
});

it('a purge that could not be queued is finished by asking again', async () => {
  const who = { cookie: await signup('undo_retry') };
  const { id } = await made(who, 'retry');
  await remove(who, id, 'retry');
  const down = { ...on, PLATFORM_QUEUE: { ...fakeQueue, send: async () => { throw new Error('queue is down'); } } } as unknown as Env;
  expect((await purge(who, id, down)).status).toBeGreaterThanOrEqual(500);
  // Asked for is asked for: it can't be restored, and the row stays to be asked again.
  expect((await restore(who, id)).body.error.code).toBe('GONE');
  expect((await api('/repos/deleted', who, {}, on)).body.repos).toHaveLength(1);
  queued.length = 0;
  expect((await purge(who, id)).status).toBe(200);
  expect(purges(id)).toHaveLength(1);
  expect((await api('/repos/deleted', who, {}, on)).body.repos).toEqual([]);
});

it('a purged fork takes nothing from its parent', async () => {
  const who = { cookie: await signup('undo_fork_purge') };
  const { id: parent } = await made(who, 'parent');
  const forked = await api(`/repos/${parent}/fork`, who, { body: { name: 'child' } }, on);
  const fork = forked.body.id as string;
  await remove(who, fork, 'child');
  queued.length = 0;
  expect((await purge(who, fork)).status).toBe(200);
  expect(await runPurges(fork)).toEqual(['ack']);
  expect((await api(`/repos/${parent}/blob?path=a.txt`, who, {}, on)).status).toBe(200);
  expect((await remove(who, parent, 'parent')).status).toBe(200);
});

it('with the window off there is nothing to purge but what it promised', async () => {
  const who = { cookie: await signup('undo_purge_off') };
  const plain = await made(who, 'plain', off);
  await remove(who, plain.id, 'plain', off);
  expect((await purge(who, plain.id, off)).status).toBe(404);
  const promised = await made(who, 'promised');
  await remove(who, promised.id, 'promised');
  expect((await purge(who, promised.id, off)).status).toBe(200);
  expect((await api('/repos/deleted', who, {}, off)).body.repos).toEqual([]);
});

it('an organization\'s owners purge its repositories, and its members cannot', async () => {
  const owner = { cookie: await signup('undo_org_purger') };
  const member = { cookie: await signup('undo_org_helper') };
  const org = 'undo_org_purge';
  expect((await api('/orgs', owner, { body: { name: org } }, on)).status).toBe(200);
  expect((await api(`/orgs/${org}/members`, owner, { body: { account: 'undo_org_helper', role: 'member' } }, on)).status).toBe(200);
  const { id } = await made(owner, 'team', on, org);
  await remove(owner, id, 'team');
  expect((await purge(member, id)).status).toBe(404);
  expect((await purge(owner, id)).status).toBe(200);
  expect((await api(`/orgs/${org}/repos/deleted`, owner, {}, on)).body.repos).toEqual([]);
  const audited = await bindings.INDEX.prepare("SELECT actor,detail FROM admin_audit WHERE action='repo.purge_owner' AND target=?").bind(id).first<any>();
  expect(audited.actor).toBe('undo_org_purger');
  expect(JSON.parse(audited.detail).owner).toBe(org);
});

it('an org lists and restores its own, and a gone org purges on schedule', async () => {
  const owner = { cookie: await signup('undo_org_owner') };
  const member = { cookie: await signup('undo_org_member') };
  const org = 'undo_org';
  expect((await api('/orgs', owner, { body: { name: org } }, on)).status).toBe(200);
  expect((await api(`/orgs/${org}/members`, owner, { body: { account: 'undo_org_member', role: 'member' } }, on)).status).toBe(200);
  const { id } = await made(owner, 'team', on, org);
  await remove(owner, id, 'team');
  const listed = await api(`/orgs/${org}/repos/deleted`, owner, {}, on);
  expect(listed.body.repos.map((r: any) => r.id)).toEqual([id]);
  expect(listed.body.window_days).toBe(30);
  expect((await api(`/orgs/${org}/repos/deleted`, member, {}, on)).status).toBe(403);
  expect((await restore(member, id)).status).toBe(404);
  expect((await api('/repos/deleted', owner, {}, on)).body.repos).toEqual([]);
  expect((await restore(owner, id)).status).toBe(200);

  await remove(owner, id, 'team', short);
  expect((await api(`/orgs/${org}?confirm=${org}`, owner, del, short)).status).toBe(200);
  // Its owners are gone with it, so nobody can restore; the sweep still ends it.
  expect((await restore(owner, id, {}, short)).status).toBe(404);
  const [job] = await purgeDue(id);
  expect(await deliver(job, short)).toBe('ack');
  expect(await stored(`platform/v1/${id}/`)).toEqual([]);
  expect(await row(id)).toBeNull();
});

it('quarantine goes on purging a leaked secret during the window', async () => {
  const who = { cookie: await signup('undo_secret') };
  const { id, commit } = await made(who, 'leak');
  const repo = `/repos/${id}`;
  const put = await api(`${repo}/quarantine`, who, { body: { path: 'a.txt', reason: 'leak', retain_days: 1 } }, on);
  expect(put.status, JSON.stringify(put.body)).toBe(200);
  const blob = put.body.record.target.id as string;
  await remove(who, id, 'leak');
  const keys = async () => (await stored(`platform/v1/${id}/`)).filter((key) => key.includes(blob));
  expect((await keys()).length).toBeGreaterThan(0);
  // Its retention has passed, well inside the window.
  const stub = bindings.SOURCE_REPOS.get(bindings.SOURCE_REPOS.idFromName(id));
  await runInDurableObject(stub, (_: unknown, state: DurableObjectState) => state.storage.sql.exec('UPDATE quarantine SET purge_after=0'));
  await quarantineJob(on, { v: 1, kind: 'platform_quarantine', repo_id: id, job_id: 'quarantine-1' });
  expect(await keys()).toEqual([]);
  expect((await api(`${repo}/refs`, who, {}, on)).body.error.code).toBe('GONE');
  // Restored, it stays purged and everything else is there.
  expect((await restore(who, id)).status).toBe(200);
  expect((await api(`${repo}/refs`, who, {}, on)).body.refs['refs/heads/main']).toBe(commit);
  expect((await api(`${repo}/blob?path=a.txt`, who, {}, on)).status).toBe(451);
});

it('an operator rebuilds the listing from the owner\'s records', async () => {
  const who = { cookie: await signup('undo_rebuild') };
  const operator = { cookie: await signup('undo_ops') };
  const { id } = await made(who, 'lost');
  await remove(who, id, 'lost');
  const was = await row(id);
  await bindings.INDEX.prepare('DELETE FROM platform_deleted_repos').run();
  expect((await api('/repos/deleted', who, {}, on)).body.repos).toEqual([]);
  const done = await api('/admin/deleted-repos/rebuild', operator, { body: { owner: 'undo_rebuild' } }, on);
  expect([done.status, done.body.repos]).toEqual([200, 1]);
  expect(await row(id)).toEqual({ ...was, sent_at: 0 });
});

it('says so in the MCP tool only where deleting can be undone', () => {
  const description = (target: Env) => toolsOf(target).find((t) => t.name === 'repo_delete')?.description;
  expect(description(off)).toContain('permanently');
  expect(description(on)).not.toContain('permanently');
  expect(description(on)).toContain('30 days');
});

it('tokens need repo:admin to list or restore', async () => {
  const who = { cookie: await signup('undo_tokens') };
  const { id } = await made(who, 'tok');
  await remove(who, id, 'tok');
  const issue = async (scopes: string[]) => (await api('/tokens', who, { body: { name: scopes[0], scopes } }, on)).body.token as string;
  const reader = { token: await issue(['repo:read']) };
  const admin = { token: await issue(['repo:admin']) };
  expect((await api('/repos/deleted', reader, {}, on)).status).toBe(403);
  expect((await restore(reader, id)).status).toBe(403);
  expect((await api('/repos/deleted', admin, {}, on)).body.repos).toHaveLength(1);
  expect((await restore(admin, id)).status).toBe(200);
});

// What a build older than the purge mark left: objects gone, the digest as it always was.
async function purgedByAnOlderBuild(id: string, target: Env) {
  await purgeRepository(target, id, { skipWindow: true });
  const stub = bindings.SOURCE_REPOS.get(bindings.SOURCE_REPOS.idFromName(id));
  await runInDurableObject(stub, (_: unknown, state: DurableObjectState) =>
    state.storage.sql.exec("UPDATE repo_settings SET policy_digest='digest-of-an-older-build'"));
}
const tombstone = (id: string) =>
  runInDurableObject(bindings.SOURCE_REPOS.get(bindings.SOURCE_REPOS.idFromName(id)), (_: unknown, state: DurableObjectState) =>
    state.storage.sql.exec('SELECT name,deleted_at,policy_digest,object_store FROM repo_settings').toArray());
const edgeCopy = (repo: string, id: string) => caches.default.match(new Request(`https://objects.yoneda.internal/${repo}/${id}`));

it('refuses a tombstone an older build purged, serves nothing from the edge, and leaves it as it was', async () => {
  const who = { cookie: await signup('undo_hollow') };
  const { id } = await made(who, 'hollow', off);
  const read = await api(`/repos/${id}/blob?path=a.txt`, who, {}, off);
  expect(read.status).toBe(200);
  await remove(who, id, 'hollow', off);
  await purgedByAnOlderBuild(id, off);
  expect(await stored(`platform/v1/${id}/`)).toEqual([]);
  expect(await edgeCopy(id, read.body.id)).toBeTruthy();
  const before = await tombstone(id);

  const refused = await restore(who, id);
  expect([refused.status, refused.body.error.code]).toEqual([404, 'GONE']);
  expect(refused.body.error.message).toMatch(/can.t be restored|too long ago/);
  expect(await tombstone(id)).toEqual(before);
  expect(await row(id)).toBeNull();
  // The edge still holds a copy, and nothing leads to it.
  expect((await api(`/repos/${id}/blob?path=a.txt`, who, {}, on)).body.error.code).toBe('GONE');
  expect((await api(`/repos/${id}/refs`, who, {}, on)).body.error.code).toBe('GONE');
  expect((await api('/repos', who, {}, on)).body.repos.map((r: any) => r.id)).not.toContain(id);
  // Its name stays free.
  expect((await made(who, 'hollow')).id).not.toBe(id);
});

it('refuses a listed tombstone whose objects another build purged, and keeps it listed', async () => {
  const who = { cookie: await signup('undo_rollback') };
  const { id } = await made(who, 'rolled');
  const read = await api(`/repos/${id}/blob?path=a.txt`, who, {}, on);
  await remove(who, id, 'rolled');
  await purgedByAnOlderBuild(id, on);
  expect(await edgeCopy(id, read.body.id)).toBeTruthy();
  const before = await tombstone(id);

  const refused = await restore(who, id);
  expect([refused.status, refused.body.error.code]).toEqual([404, 'GONE']);
  expect(refused.body.error.message).toMatch(/can.t be restored/);
  expect(await tombstone(id)).toEqual(before);
  expect(await row(id)).not.toBeNull();
  expect((await api(`/repos/${id}/blob?path=a.txt`, who, {}, on)).body.error.code).toBe('GONE');
});

it('a tombstone the window never scheduled is not restored, even with its objects in place', async () => {
  const who = { cookie: await signup('undo_unlisted') };
  const { id } = await made(who, 'unlisted', off);
  await remove(who, id, 'unlisted', off);
  expect((await stored(`platform/v1/${id}/`)).length).toBeGreaterThan(0);
  const refused = await restore(who, id);
  expect([refused.status, refused.body.error.code]).toEqual([404, 'GONE']);
  expect(refused.body.error.message).toMatch(/too long ago/);
  expect((await api(`/repos/${id}/refs`, who, {}, on)).body.error.code).toBe('GONE');
});

it('D1 losing the row costs nothing: the owner\'s record says it is on the schedule', async () => {
  const who = { cookie: await signup('undo_lost_row') };
  const { id } = await made(who, 'lostrow');
  await remove(who, id, 'lostrow');
  await bindings.INDEX.prepare('DELETE FROM platform_deleted_repos WHERE id=?').bind(id).run();
  expect((await restore(who, id)).status).toBe(200);
  expect((await api(`/repos/${id}/blob?path=a.txt`, who, {}, on)).status).toBe(200);
});

it('restores what has no objects to lose, and what is still only staged', async () => {
  const who = { cookie: await signup('undo_early') };
  const empty = await api('/repos', who, { body: { name: 'empty', policy: OPEN } }, on);
  expect(empty.status, JSON.stringify(empty.body)).toBe(200);
  await remove(who, empty.body.id, 'empty');
  const back = await restore(who, empty.body.id);
  expect(back.status, JSON.stringify(back.body)).toBe(200);

  const fresh = await api('/repos', who, { body: { name: 'fresh', policy: OPEN, files: [file('a.txt', 'a\n')], author } }, on);
  expect(fresh.status, JSON.stringify(fresh.body)).toBe(200);
  await remove(who, fresh.body.id, 'fresh');
  expect((await restore(who, fresh.body.id)).status).toBe(200);
  await drainObjects(on);
  expect((await api(`/repos/${fresh.body.id}/blob?path=a.txt`, who, {}, on)).status).toBe(200);
});

it('a look at the objects that fails restores nothing and says to try again', async () => {
  const who = { cookie: await signup('undo_look') };
  const { id } = await made(who, 'look');
  await remove(who, id, 'look');
  const before = await tombstone(id);
  const OBJECTS = new Proxy(bindings.OBJECTS, {
    get: (real, key) => (key === 'head' ? () => Promise.reject(new Error('R2 is down')) : Reflect.get(real, key)),
  });
  const failing = await restore(who, id, {}, { ...on, OBJECTS } as unknown as Env);
  expect([failing.status, failing.body.error.code]).toEqual([503, 'OVERLOADED']);
  expect(failing.body.error.message).toMatch(/try again/i);
  expect(await tombstone(id)).toEqual(before);
  expect((await restore(who, id)).status).toBe(200);
});
