// Legal hold through the real repository and account authorities (workerd), behind
// `LEGAL_HOLD`: an org owner or an operator holds an org or one repository, and every
// destructive path answers 423 until it is released, landing and reads never noticing. A
// hold that cannot be read refuses; queue jobs come back later rather than failing into the
// dead-letter queue. Off, the check does not run and the routes do not exist.
import { describe, expect, it } from 'vitest';
import { platformJob } from '../../cloudflare/worker/platform-entrypoint';
import { purgeRepository } from '../../cloudflare/worker/repo-admin';
import { eraseJob } from '../../cloudflare/worker/repo-erase';
import { quarantineJob } from '../../cloudflare/worker/repo-quarantine';
import { shardCall } from '../../cloudflare/worker/repo-shards';
import type { Env, Envelope } from '../../cloudflare/worker/types';
import { api, author, bindings, delayed, file, queued, scoped, signup, usePlatformFixture } from './repo-fixture';

usePlatformFixture();

const on = { ...scoped, PLATFORM_OBJECT_STORE: 'r2', LEGAL_HOLD: 'on', ADMIN_ACCOUNTS: 'hold_ops' } as unknown as Env;
const OPEN = { required_checks: [], approvals: 0 };
const REFUSED = [423, 'LEGAL_HOLD'];
const refused = (answer: { status: number; body: any }) => [answer.status, answer.body.error?.code];
const del = { method: 'DELETE' };

let orgs = 0;
/** An org with `alice` (its creator) as owner and a repository with a closed change and a
 * release. Names are per test: the fixture keeps one authority per name. */
async function held(name: string) {
  const org = `hold_${name}_${++orgs}`;
  const owner = { cookie: await signup(`${org}_a`) };
  expect((await api('/orgs', owner, { body: { name: org } }, on)).status).toBe(200);
  const created = await api('/repos', owner, { body: { name: 'app', owner: org, policy: OPEN, files: [file('a.txt', 'a\n')], author } }, on);
  expect(created.status).toBe(200);
  const id = created.body.id as string;
  return { org, owner, id, repo: `/repos/${id}`, root: created.body.commit as string };
}

it('a held org refuses every destructive path until it is released', async () => {
  const { org, owner, id, repo, root } = await held('all');
  const tagged = await api(`${repo}/tags`, owner, { body: { name: 'v1', commit: root } }, on);
  expect(tagged.status).toBe(200);
  expect((await api(`${repo}/releases`, owner, { body: { tag: 'v1', title: 'one' } }, on)).status).toBe(200);
  const blob = (await api(`${repo}/quarantine`, owner, { body: { path: 'a.txt', reason: 'leak', retain_days: 30 } }, on)).body;
  expect(blob.record.state).toBe('quarantined');

  const set = await api(`/orgs/${org}/hold`, owner, { body: {} }, on);
  expect(set.status).toBe(200);
  expect(set.body.hold.owner.by).toMatch(/^user:/);

  expect(refused(await api(`${repo}?confirm=app`, owner, del, on))).toEqual(REFUSED);
  expect(refused(await api(`${repo}/releases/v1`, owner, del, on))).toEqual(REFUSED);
  expect(refused(await api(`${repo}/vacuum`, owner, { body: {} }, on))).toEqual(REFUSED);
  const purge = await api(`${repo}/quarantine/${blob.record.id}/purge`, owner, { body: { confirm: blob.record.target.id } }, on);
  expect(refused(purge)).toEqual(REFUSED);
  expect(refused(await api(`/orgs/${org}?confirm=${org}`, owner, del, on))).toEqual([409, 'CONFLICT']);
  // Withholding goes on.
  expect((await api(`${repo}/blob?path=a.txt`, owner, {}, on)).status).toBe(451);

  expect((await api(`/orgs/${org}/hold`, owner, del, on)).body.released).toBe(true);
  expect((await api(`${repo}/vacuum`, owner, { body: {} }, on)).status).toBe(200);
  expect((await api(`${repo}/releases/v1`, owner, del, on)).status).toBe(200);
  expect((await api(`${repo}?confirm=app`, owner, del, on)).body).toEqual({ deleted: true });
  expect((await api(`/repos/${id}`, owner, {}, on)).body.error.code).toBe('GONE');
});

it('a closed change is kept under a hold', async () => {
  const { org, owner, repo, root } = await held('change');
  const commit = await api(`${repo}/commits`, owner, { body: { parent: root, changes: [file('b.txt', 'b\n')], message: 'b', author } }, on);
  expect(commit.status).toBe(200);
  const branch = await api(`${repo}/branches`, owner, { body: { ref: 'side', commit: commit.body.commit } }, on);
  expect(branch.status).toBe(200);
  const change = await api(`${repo}/changes`, owner, { body: { title: 't', branch: 'side' } }, on);
  expect(change.status).toBe(200);
  const number = change.body.number;
  expect((await api(`${repo}/changes/${number}/close`, owner, { body: {} }, on)).status).toBe(200);
  await api(`/orgs/${org}/repos/${repo.slice(7)}/hold`, owner, { body: {} }, on);
  expect(refused(await api(`${repo}/changes/${number}`, owner, del, on))).toEqual(REFUSED);
  await api(`/orgs/${org}/repos/${repo.slice(7)}/hold`, owner, del, on);
  expect((await api(`${repo}/changes/${number}`, owner, del, on)).status).toBe(200);
});

it('a held repository of an org is held alone, and its members see that', async () => {
  const { org, owner, repo, id } = await held('one');
  const other = (await api('/repos', owner, { body: { name: 'other', owner: org, policy: OPEN, files: [file('a.txt', 'a\n')], author } }, on)).body.id as string;
  expect((await api(`/orgs/${org}/repos/${id}/hold`, owner, { body: {} }, on)).status).toBe(200);
  expect(refused(await api(`${repo}?confirm=app`, owner, del, on))).toEqual(REFUSED);
  expect((await api(`/repos/${other}?confirm=other`, owner, del, on)).status).toBe(200);
  const seen = (await api(`${repo}/hold`, owner, {}, on)).body;
  expect(seen.held).toBe(true);
  expect(seen.repo.owner.by).toMatch(/^user:/);
  expect(seen.org).toBeNull();
  expect((await api(`/orgs/${org}/hold`, owner, {}, on)).body.repos[id].owner.by).toBe(seen.repo.owner.by);
});

it('an org owner cannot hold a repository the org does not own', async () => {
  const a = await held('mine');
  const b = await held('yours');
  expect(refused(await api(`/orgs/${a.org}/repos/${b.id}/hold`, a.owner, { body: {} }, on))).toEqual([404, 'NOT_FOUND']);
  expect(refused(await api(`/orgs/${a.org}/repos/rnot-an-id/hold`, a.owner, { body: {} }, on))).toEqual([404, 'NOT_FOUND']);
  // Someone outside the org learns nothing either.
  expect(refused(await api(`/orgs/${a.org}/repos/${a.id}/hold`, b.owner, { body: {} }, on))).toEqual([403, 'FORBIDDEN']);
});

it('deleting an org is refused under a hold', async () => {
  const org = `hold_empty_${++orgs}`;
  const owner = { cookie: await signup(`${org}_a`) };
  expect((await api('/orgs', owner, { body: { name: org } }, on)).status).toBe(200);
  await api(`/orgs/${org}/hold`, owner, { body: {} }, on);
  expect(refused(await api(`/orgs/${org}?confirm=${org}`, owner, del, on))).toEqual(REFUSED);
  await api(`/orgs/${org}/hold`, owner, del, on);
  expect((await api(`/orgs/${org}?confirm=${org}`, owner, del, on)).body.deleted).toBe(true);
});

it('members see a hold and only owners change it, and a read-only token cannot', async () => {
  const { org, owner, id } = await held('roles');
  const memberName = `${org}_m`;
  const member = { cookie: await signup(memberName) };
  await api(`/orgs/${org}/members`, owner, { body: { account: memberName, role: 'member' } }, on);
  expect((await api(`/orgs/${org}/hold`, member, {}, on)).body).toEqual({ org: null, repos: {} });
  expect(refused(await api(`/orgs/${org}/hold`, member, { body: {} }, on))).toEqual([403, 'FORBIDDEN']);
  expect(refused(await api(`/orgs/${org}/repos/${id}/hold`, member, { body: {} }, on))).toEqual([403, 'FORBIDDEN']);
  const read = (await api('/tokens', owner, { body: { name: 'r', scopes: ['repo:read'] } })).body.token as string;
  expect(refused(await api(`/orgs/${org}/hold`, { token: read }, { body: {} }, on))).toEqual([403, 'FORBIDDEN']);
});

it('hold changes reach the org audit log, an operator\'s with its layer and actor', async () => {
  const { org, owner, id } = await held('audited');
  const audited = { ...on, AUDIT_LOG: 'on' } as unknown as Env;
  const ops = { cookie: await signup('hold_ops') };
  await api(`/orgs/${org}/hold`, owner, { body: {} }, audited);
  await api(`/orgs/${org}/hold`, owner, del, audited);
  await api(`/admin/repos/${id}/hold`, ops, { body: {} }, audited);
  const { items } = (await api(`/orgs/${org}/audit`, owner, {}, audited)).body;
  const seen = items.filter((e: any) => e.kind.startsWith('legal_hold.'));
  const row = (e: any) => [e.kind, e.actor, e.details.layer];
  expect(seen.map(row).sort()).toEqual([
    ['legal_hold.released', `user:${org}_a`, 'owner'],
    ['legal_hold.set', `user:${org}_a`, 'owner'],
    ['legal_hold.set', 'hold_ops', 'operator'],
  ].sort());
});

describe('a lifted hold and Tower', () => {
  const clearing = { ...on, LAND_WHEN_CLEARED: 'on' } as unknown as Env;
  const JOB = 'platform_land_check';
  const jobs = (repo: string) => {
    const mine = queued.filter((m) => m.kind === JOB && m.repo_id === repo);
    queued.splice(0, queued.length, ...queued.filter((m) => !mine.includes(m)));
    return mine as Envelope[];
  };
  const deliver = async (env: Env, body: Envelope) => {
    const message = { body, attempts: 1, ack() {}, retry() {} };
    await platformJob(env, message as unknown as Message<Envelope>);
  };
  /** An org's repository with a Landing that an approval cleared, held at its job. */
  async function heldLanding(name: string) {
    const org = `hold_${name}_${++orgs}`;
    const owner = { cookie: await signup(`${org}_a`) };
    await api('/orgs', owner, { body: { name: org } }, clearing);
    const policy = { approvals: 1, required_checks: [] };
    const created = await api('/repos', owner, { body: { name: 'app', owner: org, policy, files: [file('a.txt', 'a\n')], author } }, clearing);
    const repo = created.body.id as string;
    const token = (await api(`/repos/${repo}/tokens`, owner, { body: { name: 'agent', scopes: ['read', 'write'] } }, clearing)).body.token as string;
    await api(`/repos/${repo}/auto-landings`, owner, { method: 'PUT', body: { land_when_cleared: true } }, clearing);
    const made = await api(`/repos/${repo}/commits`, { token }, { body: { parent: created.body.commit, base_version: 1, message: 'fix', author, changes: [file('b.txt', 'b\n')] } }, clearing);
    await api(`/repos/${repo}/refs/batch`, { token }, { body: { updates: [{ ref: 'fix', commit: made.body.commit, expected: null }] } }, clearing);
    const { number } = (await api(`/repos/${repo}/changes`, { token }, { body: { branch: 'fix', title: 'fix' } }, clearing)).body;
    await api(`/repos/${repo}/commits/${made.body.commit}/reviews`, owner, { body: { decision: 'approve' } }, clearing);
    const change = async () => (await api(`/repos/${repo}/changes/${number}`, owner, {}, clearing)).body;
    return { org, owner, repo, number, change };
  }
  async function landsOnceLifted({ repo, number, change }: Awaited<ReturnType<typeof heldLanding>>, release: () => Promise<unknown>) {
    const [held] = jobs(repo);
    await deliver(clearing, held);
    const { clearances } = await change();
    expect(clearances[0].reasons.map((r: { code: string }) => r.code)).toEqual(['LEGAL_HOLD']);
    expect((await change()).status).toBe('open');
    await release();
    const [ask, ...rest] = jobs(repo);
    expect(rest).toEqual([]);
    expect(ask.number).toBeUndefined();
    await deliver(clearing, ask);
    const [land] = jobs(repo);
    expect(land.number).toBe(number);
    await deliver(clearing, land);
    expect((await change()).status).toBe('landed');
  }

  it('asks again when a hold on one repository lifts', async () => {
    const landing = await heldLanding('one');
    const { org, owner, repo } = landing;
    await api(`/orgs/${org}/repos/${repo}/hold`, owner, { body: {} }, clearing);
    await landsOnceLifted(landing, () => api(`/orgs/${org}/repos/${repo}/hold`, owner, del, clearing));
  });

  it('asks again on every repository when a hold on the org lifts', async () => {
    const landing = await heldLanding('org');
    const { org, owner } = landing;
    await api(`/orgs/${org}/hold`, owner, { body: {} }, clearing);
    await landsOnceLifted(landing, () => api(`/orgs/${org}/hold`, owner, del, clearing));
  });

  it('asks again when an operator lifts theirs', async () => {
    const landing = await heldLanding('operator');
    const ops = { cookie: await signup('hold_ops') };
    await api(`/admin/repos/${landing.repo}/hold`, ops, { body: {} }, clearing);
    await landsOnceLifted(landing, () => api(`/admin/repos/${landing.repo}/hold`, ops, del, clearing));
  });

  it('a release that lifted nothing asks nothing', async () => {
    const { org, owner, repo } = await heldLanding('nothing');
    jobs(repo);
    await api(`/orgs/${org}/repos/${repo}/hold`, owner, del, clearing);
    expect(jobs(repo)).toEqual([]);
  });
});

it('a token limited to other repositories cannot touch this one\'s hold', async () => {
  const { org, owner, id } = await held('allowlist');
  const other = (await api('/repos', owner, { body: { name: 'other', owner: org, policy: OPEN, files: [file('a.txt', 'a\\n')], author } }, on)).body.id as string;
  const mint = async (repos: string[]) =>
    (await api('/tokens', owner, { body: { name: `t${repos[0]}`, scopes: ['repo:admin'], repos } })).body.token as string;
  const elsewhere = await mint([other]);
  expect(refused(await api(`/orgs/${org}/repos/${id}/hold`, { token: elsewhere }, { body: {} }, on))).toEqual([403, 'FORBIDDEN']);
  expect((await api(`/orgs/${org}/repos/${other}/hold`, { token: elsewhere }, { body: {} }, on)).status).toBe(200);
  expect((await api(`/orgs/${org}/hold`, owner, {}, on)).body.repos[id]).toBeUndefined();
  expect(refused(await api(`/orgs/${org}/hold`, { token: elsewhere }, { body: {} }, on))).toEqual([403, 'FORBIDDEN']);
});

it('a personal owner cannot set a hold; an operator can, and only an operator lifts it', async () => {
  const person = 'hold_person';
  const cookie = await signup(person);
  const id = (await api('/repos', { cookie }, { body: { name: 'mine', policy: OPEN, files: [file('a.txt', 'a\n')], author } }, on)).body.id as string;
  expect(refused(await api(`/orgs/${person}/hold`, { cookie }, { body: {} }, on))).toEqual([404, 'NOT_FOUND']);
  const ops = { cookie: await signup('hold_ops') };
  expect(refused(await api(`/admin/repos/${id}/hold`, { cookie }, { body: {} }, on))).toEqual([403, 'FORBIDDEN']);
  const set = await api(`/admin/repos/${id}/hold`, ops, { body: {} }, on);
  expect(set.body.hold.operator.by).toBe('hold_ops');
  expect(refused(await api(`/repos/${id}?confirm=mine`, { cookie }, del, on))).toEqual(REFUSED);
  expect((await api(`/admin/repos/${id}/hold`, ops, del, on)).body.released).toBe(true);
  expect((await api(`/repos/${id}?confirm=mine`, { cookie }, del, on)).status).toBe(200);
  const audits = await bindings.INDEX.prepare("SELECT actor,action,target FROM admin_audit WHERE target=? ORDER BY id").bind(id).all<any>();
  expect(audits.results).toEqual([
    { actor: 'hold_ops', action: 'legal_hold.set', target: id },
    { actor: 'hold_ops', action: 'legal_hold.release', target: id },
  ]);
});

it('an operator hold on an org outlives its owners and is audited', async () => {
  const { org, owner, repo } = await held('operator');
  const ops = { cookie: await signup('hold_ops') };
  expect((await api(`/admin/orgs/${org}/hold`, ops, { body: {} }, on)).status).toBe(200);
  expect(refused(await api(`/orgs/${org}/hold`, owner, del, on))).toEqual([403, 'FORBIDDEN']);
  expect(refused(await api(`${repo}?confirm=app`, owner, del, on))).toEqual(REFUSED);
  expect((await api(`/admin/orgs/${org}/hold`, ops, del, on)).status).toBe(200);
  expect((await api(`${repo}?confirm=app`, owner, del, on)).status).toBe(200);
  expect(refused(await api('/admin/orgs/nobody_here/hold', ops, { body: {} }, on))).toEqual([404, 'NOT_FOUND']);
});

it('a hold placed on a tombstone keeps it: the purge comes back later, not to the dead-letter queue', async () => {
  const { org, owner, id, repo } = await held('tomb');
  expect((await api(`${repo}?confirm=app`, owner, del, on)).status).toBe(200);
  expect((await api(`/orgs/${org}/repos/${id}/hold`, owner, { body: {} }, on)).status).toBe(200);
  const [job] = queued.filter((m) => m.kind === 'platform_purge' && m.repo_id === id);
  let settled = '';
  const message = { body: job, attempts: 1, ack: () => { settled = 'ack'; }, retry: () => { settled = 'retry'; } };
  const before = await bindings.OBJECTS.list({ prefix: `store/v1/yr-${id}/` });
  await platformJob(on, message as unknown as Message<any>);
  expect(settled).toBe('ack');
  expect(delayed.filter((m) => m.kind === 'platform_purge' && m.repo_id === id)).toHaveLength(1);
  expect((await bindings.OBJECTS.list({ prefix: `store/v1/yr-${id}/` })).objects.length).toBe(before.objects.length);
  await api(`/orgs/${org}/repos/${id}/hold`, owner, del, on);
  await purgeRepository(on, id);
});

it('an erase waits out a hold: shards and records stay until it is released', async () => {
  const { org, owner, id, repo } = await held('erase');
  const erasing = { ...on, REPO_ERASE: 'on', ARTIFACTS: undefined } as unknown as Env;
  expect((await api(`${repo}?confirm=app`, owner, del, erasing)).status).toBe(200);
  await api(`/orgs/${org}/repos/${id}/hold`, owner, { body: {} }, erasing);
  const job = { v: 1, kind: 'platform_erase', repo_id: id, job_id: 'start' } as const;
  let settled = '';
  const message = { body: job, attempts: 1, ack: () => { settled = 'ack'; }, retry: () => { settled = 'retry'; } };
  await platformJob(erasing, message as unknown as Message<any>);
  expect(settled).toBe('ack');
  expect(delayed.filter((m) => m.kind === 'platform_erase' && m.repo_id === id)).toHaveLength(1);
  expect((await shardCall(erasing, id, 0, { op: 'store_status' })).db_bytes).toBeGreaterThan(0);
  await expect(eraseJob(erasing, { ...job, job_id: 'records' })).rejects.toMatchObject({ code: 'LEGAL_HOLD' });
  await api(`/orgs/${org}/repos/${id}/hold`, owner, del, erasing);
  await eraseJob(erasing, job);
  await expect(shardCall(erasing, id, 0, { op: 'store_status' })).rejects.toMatchObject({ code: 'GONE' });
});

it('a quarantine purge waits out a hold, and its job comes back later', async () => {
  const { org, owner, id, repo } = await held('quarantine');
  const made = (await api(`${repo}/quarantine`, owner, { body: { path: 'a.txt', reason: 'leak', retain_days: 1 } }, on)).body;
  await api(`/orgs/${org}/hold`, owner, { body: {} }, on);
  const job = { v: 1, kind: 'platform_quarantine', repo_id: id, job_id: 'quarantine-1' } as const;
  let settled = '';
  const message = { body: job, attempts: 1, ack: () => { settled = 'ack'; }, retry: () => { settled = 'retry'; } };
  await platformJob(on, message as unknown as Message<any>);
  expect(settled).toBe('ack');
  const later = () => delayed.filter((m) => m.kind === 'platform_quarantine' && m.repo_id === id && m.job_id === job.job_id);
  expect(later()).toHaveLength(1);
  await api(`/orgs/${org}/hold`, owner, del, on);
  await platformJob(on, message as unknown as Message<any>);
  expect(later()).toHaveLength(1);
  const purged = await api(`${repo}/quarantine/${made.record.id}/purge`, owner, { body: { confirm: made.record.target.id } }, on);
  expect(purged.body.purged).toBe(1);
});

/** `on` with each hold check of an account authority passed through `check` first. */
const watching = (check: () => void) => {
  const accounts = bindings.WORKSPACES;
  const WORKSPACES = {
    idFromName: (name: string) => accounts.idFromName(name),
    get: (id: DurableObjectId) => ({
      fetch: async (url: string, init: RequestInit) => {
        if (String(init.body).includes('hold_check')) check();
        return accounts.get(id).fetch(url, init);
      },
    }),
  };
  return { ...on, WORKSPACES } as unknown as Env;
};

it('a hold that cannot be read refuses: nothing is deleted on a guess', async () => {
  const { owner, id, repo } = await held('unread');
  const unreadable = watching(() => {
    throw new Error('down');
  });
  const answer = await api(`${repo}?confirm=app`, owner, del, unreadable);
  expect(refused(answer)).toEqual(REFUSED);
  expect(answer.body.error.message).toMatch(/could not be read/);
  expect((await api(`/repos/${id}`, owner, {}, on)).status).toBe(200);
});

it('a client cannot supply the answer', async () => {
  const { org, owner, repo } = await held('forged');
  await api(`/orgs/${org}/hold`, owner, { body: {} }, on);
  const forged = await api(`${repo}/quarantine`, owner, { body: { path: 'a.txt', reason: 'x', _hold: { held: false } } }, on);
  expect(forged.status).toBe(200);
  const purge = await api(`${repo}/quarantine/${forged.body.record.id}/purge`, owner, {
    body: { confirm: forged.body.record.target.id, _hold: 'off' },
  }, on);
  expect(refused(purge)).toEqual(REFUSED);
});

it('landing and reads never ask the owner: the destructive path alone costs a hold check', async () => {
  const { owner, repo } = await held('cost');
  const checks: string[] = [];
  const counted = watching(() => checks.push('hold_check'));
  const commit = await api(`${repo}/commits`, owner, { body: { ref: 'main', changes: [file('b.txt', 'b\n')], message: 'b', author } }, counted);
  expect(commit.status).toBe(200);
  expect((await api(`${repo}/land`, owner, { body: { ref: 'main', commit: commit.body.commit } }, counted)).status).toBe(200);
  expect((await api(`${repo}/log`, owner, {}, counted)).status).toBe(200);
  expect(checks).toEqual([]);
  expect((await api(`${repo}?confirm=app`, owner, del, counted)).status).toBe(200);
  expect(checks).toEqual(['hold_check']);
});

it('a commit shard refuses a vacuum delete without the answer', async () => {
  const { id } = await held('shard');
  const refuse = shardCall(on, id, 0, { op: 'store_vacuum_delete', ids: [] });
  await expect(refuse).rejects.toMatchObject({ code: 'HOLD_UNCHECKED' });
  expect((await shardCall(on, id, 0, { op: 'store_vacuum_delete', ids: [], _hold: { held: false } })).deleted).toBe(0);
  await expect(shardCall(on, id, 0, { op: 'store_erase' })).rejects.toMatchObject({ code: 'HOLD_UNCHECKED' });
  await expect(shardCall(on, id, 0, { op: 'store_erase', _hold: { held: true } })).rejects.toMatchObject({ code: 'LEGAL_HOLD' });
});

it('off: the routes do not exist, nothing is checked, and an old hold stops nothing', async () => {
  const { org, owner, repo } = await held('off');
  await api(`/orgs/${org}/hold`, owner, { body: {} }, on);
  const off = { ...on, LEGAL_HOLD: undefined } as unknown as Env;
  const ops = { cookie: await signup('hold_ops') };
  for (const [path, who, init] of [
    [`/orgs/${org}/hold`, owner, {}],
    [`/orgs/${org}/hold`, owner, { body: {} }],
    [`/orgs/${org}/repos/${repo.slice(7)}/hold`, owner, { body: {} }],
    [`${repo}/hold`, owner, {}],
    [`/admin/orgs/${org}/hold`, ops, { body: {} }],
    [`/admin/repos/${repo.slice(7)}/hold`, ops, { body: {} }],
  ] as const) {
    expect(refused(await api(path, who, init, off)), path).toEqual([404, 'NOT_FOUND']);
  }
  expect((await api(`${repo}?confirm=app`, owner, del, off)).status).toBe(200);
  expect((await api(`/orgs/${org}?confirm=${org}`, owner, del, off)).body.deleted).toBe(true);
});
