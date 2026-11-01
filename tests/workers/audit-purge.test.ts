// A repository's audit trail against its purge, behind AUDIT_LOG, with REPO_ERASE on or off:
// the records wait until the log has every event, whatever failed and however often the jobs
// are delivered, so a deleted repository's trail outlives it. Off, none of this runs.
import { env as bindings, runInDurableObject } from 'cloudflare:test';
import { expect, it, vi } from 'vitest';
import { platformJob } from '../../cloudflare/worker/platform-entrypoint';
import { forgetOrgAccess } from '../../cloudflare/worker/platform-org-access';
import { platformFetch } from '../../cloudflare/worker/platform-routes';
import { caller } from '../../cloudflare/worker/repo-ops';
import type { Env, Json } from '../../cloudflare/worker/types';
import { auditLog, workspace } from '../../cloudflare/worker/workspace';
import { api, author, delayed, file, queued, scoped, signup, usePlatformFixture } from './repo-fixture';

usePlatformFixture();

const r2 = { ...scoped, PLATFORM_OBJECT_STORE: 'r2', ARTIFACTS: undefined, ADMIN_ACCOUNTS: 'audit_operator' } as unknown as Env;
/** Erasing, and logging. */
const on = { ...r2, REPO_ERASE: 'on', AUDIT_LOG: 'on' } as unknown as Env;
const noErase = { ...on, REPO_ERASE: undefined } as unknown as Env;
const undo = { ...on, REPO_UNDO_DAYS: '30' } as unknown as Env;
const logOff = { ...on, AUDIT_LOG: 'off' } as unknown as Env;
const policy = { required_checks: [], approvals: 0 };
type Auth = { cookie: string };

/** `base` with its `audit:` instances down. */
function logDown(base: Env = on): Env {
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

/** `base` losing the answer to `op`: the repository never hears it, or it ran and nobody knows. */
function losing(op: string, base: Env = on): Env {
  const real = bindings.SOURCE_REPOS as unknown as DurableObjectNamespace;
  const SOURCE_REPOS = {
    idFromName: (name: string) => real.idFromName(name),
    get: (id: DurableObjectId) => ({
      fetch: async (input: string, init: RequestInit) => {
        if (String(init?.body).includes(`"op":"${op}"`)) throw new Error('connection lost');
        return real.get(id).fetch(input, init);
      },
    }),
  };
  return { ...base, SOURCE_REPOS } as unknown as Env;
}

const authority = (repo: string) => bindings.SOURCE_REPOS.get(bindings.SOURCE_REPOS.idFromName(repo));
const waiting = (repo: string) =>
  runInDurableObject(authority(repo), (_, state) =>
    state.storage.sql.exec<{ n: number }>('SELECT COUNT(*) AS n FROM hook_outbox').one().n,
  );

async function made(who: Auth, org: string, name = 'app', target = on) {
  const body = { name, policy, files: [file('a.md', 'a\n')], author, owner: org };
  const created = await api('/repos', who, { body }, target);
  expect(created.status, JSON.stringify(created.body)).toBe(200);
  return created.body.id as string;
}
async function org(name: string, who = name) {
  const auth = { cookie: await signup(who) };
  expect((await api('/orgs', auth, { body: { name } }, on)).status).toBe(200);
  return auth;
}
const quiet = () => vi.spyOn(console, 'warn').mockImplementation(() => {});

/** Every row of `name`'s log from a repository, oldest first. */
async function trail(name: string) {
  const rows: Json[] = [];
  for (let before: number | undefined; ; ) {
    const page = await auditLog(on, name, { op: 'audit_read', ...(before && { before }) });
    rows.push(...(page.items as Json[]).filter((row) => row.source.startsWith('repo:')));
    if (!page.next) return rows.reverse();
    before = page.next;
  }
}
const kinds = (rows: Json[]) => rows.map((row) => row.kind);

/** Delivers `repo`'s jobs as the queue does, each `times` over; what a job puts back runs too. */
async function deliver(repo: string, target: Env, times = 1) {
  for (let turn = 0; turn < 50; turn++) {
    const jobs = queued.filter((m) => ['platform_purge', 'platform_erase'].includes(m.kind) && m.repo_id === repo);
    if (jobs.length === 0) return;
    queued.splice(0, queued.length, ...queued.filter((m) => !jobs.includes(m)));
    for (const body of jobs)
      for (let n = 0; n < times; n++)
        await platformJob(target, { body, attempts: 1, ack() {}, retry() {} } as unknown as Message<any>);
  }
  throw new Error('the jobs never finished');
}
/** The jobs put off for later, now due. */
function due(repo: string) {
  const later = delayed.filter((m) => m.repo_id === repo);
  delayed.splice(0, delayed.length, ...delayed.filter((m) => !later.includes(m)));
  queued.push(...later);
  return later;
}
const erased = async (repo: string) =>
  (await caller(on, repo, { _system: 'erase' })({ op: 'repo_erase_plan' })).erased === true;

it('a log down through the purge costs nothing: the erase waits for it', async () => {
  const who = await org('acme', 'audit_gap');
  const id = await made(who, 'acme');
  quiet();
  const down = logDown();
  await api(`/repos/${id}?confirm=app`, who, { method: 'DELETE' }, down);
  expect(await waiting(id)).toBe(1);
  await deliver(id, down);
  expect(await erased(id)).toBe(false);
  expect(await waiting(id)).toBe(1);
  // Still down at the next look: it keeps waiting, and no job has run out of retries.
  expect(due(id)).toHaveLength(1);
  await deliver(id, down);
  expect(await erased(id)).toBe(false);

  expect(due(id)).toHaveLength(1);
  await deliver(id, on);
  expect(kinds(await trail('acme'))).toEqual(['repo.created', 'repo.deleted']);
  expect(await erased(id)).toBe(true);
  expect(await waiting(id)).toBe(0);
  expect((await auditLog(on, 'acme', { op: 'audit_verify' })).ok).toBe(true);
});

it('a backlog longer than one copy reaches the log before the records go', async () => {
  const who = await org('acme', 'audit_long');
  const id = await made(who, 'acme');
  await runInDurableObject(authority(id), (_, state) => {
    for (let n = 0; n < 2100; n++)
      state.storage.sql.exec(
        'INSERT INTO hook_outbox(hook_id,event,payload) VALUES(0,?,?)',
        'repo.visibility_changed',
        JSON.stringify({ visibility: 'public', name: 'app', actor: 'user:audit_long', at: n + 1 }),
      );
  });
  expect((await api(`/repos/${id}?confirm=app`, who, { method: 'DELETE' }, logDown())).status).toBe(200);
  await deliver(id, on);
  for (let n = 0; n < 5 && !(await erased(id)); n++) {
    due(id);
    await deliver(id, on);
  }
  const rows = await trail('acme');
  expect(rows).toHaveLength(2102);
  expect(rows.at(-1)?.kind).toBe('repo.deleted');
  expect(await erased(id)).toBe(true);
});

it("an operator's purge copies too: an earlier copy may have failed", async () => {
  const who = await org('acme', 'audit_ops');
  const id = await made(who, 'acme', 'app', undo);
  quiet();
  await api(`/repos/${id}?confirm=app`, who, { method: 'DELETE' }, logDown(undo));
  expect(await waiting(id)).toBe(1);
  await api(`/admin/repos/${id}/purge-now`, { cookie: await signup('audit_operator') }, { body: {} }, undo);
  await deliver(id, undo);
  expect(kinds(await trail('acme'))).toEqual(['repo.created', 'repo.deleted']);
  expect(await erased(id)).toBe(true);
});

it("a repository whose org is gone still reaches the org's log", async () => {
  const who = await org('acme', 'audit_orphan');
  const id = await made(who, 'acme');
  await workspace(on, 'acme', { op: 'owned_repo_release', repo: id });
  await workspace(on, 'acme', { op: 'org_delete', actor: 'audit_orphan', confirm: 'acme', _hold: 'off' });
  forgetOrgAccess('acme');
  const done = await api(`/admin/repos/${id}/purge-orphan`, { cookie: await signup('audit_operator') }, { body: { confirm: 'app' } }, on);
  expect(done.status, JSON.stringify(done.body)).toBe(200);
  await deliver(id, on);
  expect(kinds(await trail('acme'))).toEqual(['repo.created', 'repo.deleted']);
  expect((await trail('acme'))[1].actor).toBe('admin');
  expect(await erased(id)).toBe(true);
});

it('a failed create leaves nothing to wait for, and nothing in the log', async () => {
  const who = await org('acme', 'audit_back');
  const made = await api('/repos', who, { body: { name: 'app', owner: 'acme', policy, tokens: [{ name: 'bad name!', scopes: ['read'] }] } }, on);
  expect(made.status).toBe(400);
  const job = queued.find((m) => m.kind === 'platform_purge');
  await deliver(job.repo_id, on);
  expect(await trail('acme')).toEqual([]);
  expect(await erased(job.repo_id)).toBe(true);
  expect(delayed.filter((m) => m.repo_id === job.repo_id)).toEqual([]);
});

it('every job delivered twice leaves each event once', async () => {
  const who = await org('acme', 'audit_twice');
  const id = await made(who, 'acme');
  quiet();
  await api(`/repos/${id}?confirm=app`, who, { method: 'DELETE' }, logDown());
  await deliver(id, on, 2);
  expect(kinds(await trail('acme'))).toEqual(['repo.created', 'repo.deleted']);
  expect(await erased(id)).toBe(true);
});

it('a copy whose settling is lost is repeated, and the log drops the repeat', async () => {
  const who = await org('acme', 'audit_ack');
  const id = await made(who, 'acme');
  quiet();
  const lost = losing('repo_audit_done');
  await api(`/repos/${id}?confirm=app`, who, { method: 'DELETE' }, lost);
  expect(await waiting(id)).toBe(1);
  // The log has it and the repository doesn't know: the records still wait for that answer.
  await deliver(id, lost);
  expect(await erased(id)).toBe(false);
  expect(kinds(await trail('acme'))).toEqual(['repo.created', 'repo.deleted']);
  due(id);
  await deliver(id, on);
  expect(kinds(await trail('acme'))).toEqual(['repo.created', 'repo.deleted']);
  expect(await erased(id)).toBe(true);
});

it('with the erase off, a job keeps trying until the log has what waits', async () => {
  const who = await org('acme', 'audit_keep');
  const id = await made(who, 'acme', 'app', noErase);
  quiet();
  const down = logDown(noErase);
  await api(`/repos/${id}?confirm=app`, who, { method: 'DELETE' }, down);
  await deliver(id, down);
  expect(await waiting(id)).toBe(1);
  expect(due(id)).toHaveLength(1);
  await deliver(id, noErase);
  expect(await waiting(id)).toBe(0);
  expect(kinds(await trail('acme'))).toEqual(['repo.created', 'repo.deleted']);
  expect(delayed.filter((m) => m.repo_id === id)).toEqual([]);
});

it('off, nothing waits and nothing is held back', async () => {
  const who = await org('acme', 'audit_quiet');
  const id = await made(who, 'acme', 'app', logOff);
  await api(`/repos/${id}?confirm=app`, who, { method: 'DELETE' }, logOff);
  expect(await waiting(id)).toBe(0);
  await deliver(id, logOff);
  expect(await erased(id)).toBe(true);
  expect(delayed.filter((m) => m.repo_id === id)).toEqual([]);
  expect(await trail('acme')).toEqual([]);
  expect((await bindings.OBJECTS.list({ prefix: 'audit/v1/' })).objects).toEqual([]);
});

it('events left waiting when the switch goes off are erased with the rest', async () => {
  const who = await org('acme', 'audit_turned');
  const id = await made(who, 'acme');
  quiet();
  await api(`/repos/${id}?confirm=app`, who, { method: 'DELETE' }, logDown());
  expect(await waiting(id)).toBe(1);
  await deliver(id, logOff);
  expect(await erased(id)).toBe(true);
  expect(await trail('acme')).toHaveLength(1);
});

const sealed = async () => (await bindings.OBJECTS.list({ prefix: 'audit/v1/acme/' })).objects.map((o) => o.key);
const segment = async (key: string) => (await bindings.OBJECTS.get(key))?.json<Json>();

it("a deleted repository's trail is sealed, and no purge or erase touches the seal", async () => {
  const who = await org('acme', 'audit_seal');
  const id = await made(who, 'acme');
  await api(`/repos/${id}/visibility`, who, { method: 'PUT', body: { visibility: 'public' } }, on);
  expect(await sealed()).toEqual([]);
  await api(`/repos/${id}?confirm=app`, who, { method: 'DELETE' }, on);
  await deliver(id, on);
  expect(await erased(id)).toBe(true);

  const keys = await sealed();
  expect(keys).toEqual(['audit/v1/acme/000000000001-000000000004.json']);
  const body = await segment(keys[0]);
  expect(body).toMatchObject({ v: 1, org: 'acme', from: 1, to: 4, previous: '' });
  expect(kinds(body?.rows).filter((k: string) => k.startsWith('repo.'))).toEqual(['repo.created', 'repo.visibility_changed', 'repo.deleted']);
  expect(body?.rows.map((row: Json) => row.seq)).toEqual([1, 2, 3, 4]);
  expect(body?.hash).toBe(body?.rows.at(-1).hash);
  for (const [n, row] of (body?.rows as Json[]).entries())
    expect(row.previous).toBe(n === 0 ? '' : body?.rows[n - 1].hash);
  const { items } = await auditLog(on, 'acme', { op: 'audit_read' });
  expect(items[0].hash).toBe(body?.hash);

  // A repeated purge and erase write nothing new, and take nothing away.
  queued.push({ v: 1, kind: 'platform_purge', repo_id: id, job_id: `purge-${id}` });
  queued.push({ v: 1, kind: 'platform_erase', repo_id: id, job_id: 'start' });
  await deliver(id, on);
  expect(await sealed()).toEqual(keys);
});

it('the next seal starts where the last ended, and a lost seal is repeated', async () => {
  const who = await org('acme', 'audit_next');
  const first = await made(who, 'acme', 'one');
  await api(`/repos/${first}?confirm=one`, who, { method: 'DELETE' }, on);
  await deliver(first, on);
  const second = await made(who, 'acme', 'two');
  // The object is written and the seal doesn't move: the same rows go out again, unharmed.
  const real = bindings.WORKSPACES as unknown as DurableObjectNamespace;
  const stuck = {
    ...on,
    WORKSPACES: {
      idFromName: (name: string) => real.idFromName(name),
      get: (id: DurableObjectId) => ({
        fetch: async (input: string, init: RequestInit) => {
          if (String(init?.body).includes('audit_seal_done')) throw new Error('connection lost');
          return real.get(id).fetch(input, init);
        },
      }),
    },
  } as unknown as Env;
  quiet();
  await api(`/repos/${second}?confirm=two`, who, { method: 'DELETE' }, on);
  await deliver(second, stuck);
  const after = await sealed();
  expect(after).toHaveLength(2);
  queued.push({ v: 1, kind: 'platform_erase', repo_id: second, job_id: 'start' });
  await deliver(second, on);
  expect(await sealed()).toEqual(after);
  const [one, two] = await Promise.all(after.map(segment));
  expect(two?.from).toBe((one?.to ?? 0) + 1);
  expect(two?.previous).toBe(one?.hash);
});

it('a person has no log and leaves no seal', async () => {
  const who = { cookie: await signup('audit_person') };
  const created = await api('/repos', who, { body: { name: 'mine', policy, files: [file('a.md', 'a\n')], author } }, on);
  const id = created.body.id as string;
  await api(`/repos/${id}?confirm=mine`, who, { method: 'DELETE' }, on);
  await deliver(id, on);
  expect(await erased(id)).toBe(true);
  expect((await bindings.OBJECTS.list({ prefix: 'audit/v1/' })).objects).toEqual([]);
});

it('an export is in the log before a byte leaves, with who took it and what it asked for', async () => {
  const who = await org('acme', 'audit_taker');
  const refused = await api('/orgs/acme/audit/export?format=xml', who, {}, on);
  expect(refused.status).toBe(400);
  const stranger = { cookie: await signup('audit_stranger') };
  expect((await api('/orgs/acme/audit/export', stranger, {}, on)).status).toBe(403);
  const page = await api('/orgs/acme/audit?kind=audit.exported', who, {}, on);
  expect(page.body.items).toEqual([]);

  const take = (query: string) =>
    platformFetch(new Request(`https://yoneda/api/v1/orgs/acme/audit/export${query}`, { headers: { cookie: who.cookie } }), on);
  const csv = await take('?format=csv&kind=org.created');
  expect(csv.status).toBe(200);
  expect(await csv.text()).toContain('org.created');
  const { items } = (await api('/orgs/acme/audit?kind=audit.exported', who, {}, on)).body;
  expect(items).toHaveLength(1);
  expect(items[0]).toMatchObject({ actor: 'user:audit_taker', source: 'log', details: { format: 'csv', kind: 'org.created' } });
  // Each download is one row, and the chain holds them with the rest.
  await (await take('')).text();
  expect((await api('/orgs/acme/audit?kind=audit.exported', who, {}, on)).body.items).toHaveLength(2);
  expect((await api('/orgs/acme/audit/verify', who, {}, on)).body.ok).toBe(true);
});

const HOUR = 60 * 60_000;
/** The job waiting for a look, its wait backdated as if it began `ago` milliseconds back. */
function backdated(repo: string, ago: number) {
  const [job] = delayed.filter((m) => m.kind === 'platform_erase' && m.repo_id === repo);
  job.blocked_since = Date.now() - ago;
  return job.blocked_since as number;
}
/** Every `event` line the platform logged, as written. */
function alerts() {
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  return (event: string) =>
    error.mock.calls.map(([line]) => JSON.parse(String(line))).filter((line) => line.event === event);
}
const oldest = (repo: string) =>
  runInDurableObject(authority(repo), (_, state) =>
    state.storage.sql.exec<{ seq: number }>('SELECT seq FROM hook_outbox ORDER BY seq LIMIT 1').one().seq,
  );

it('an erase held up past an hour raises an alert, once past it, and still loses nothing', async () => {
  const who = await org('acme', 'audit_held');
  const id = await made(who, 'acme');
  quiet();
  const logged = alerts();
  const down = logDown();
  await api(`/repos/${id}?confirm=app`, who, { method: 'DELETE' }, down);
  const seq = await oldest(id);
  await deliver(id, down);
  expect(delayed.filter((m) => m.repo_id === id)).toHaveLength(1);
  expect(logged('audit.erase_blocked')).toEqual([]);

  // Under the limit: nothing yet, and the wait keeps its start.
  const since = backdated(id, HOUR - 60_000);
  due(id);
  await deliver(id, down);
  expect(logged('audit.erase_blocked')).toEqual([]);
  expect(delayed.find((m) => m.repo_id === id)?.blocked_since).toBe(since);

  backdated(id, HOUR + 60_000);
  due(id);
  await deliver(id, down);
  const [alert, ...more] = logged('audit.erase_blocked');
  expect(more).toEqual([]);
  expect(alert).toMatchObject({ repo: id, seq });
  expect(alert.elapsed_ms).toBeGreaterThanOrEqual(HOUR);
  expect(await erased(id)).toBe(false);
  expect(await waiting(id)).toBe(1);

  // Every later look repeats it, so the finding stays open while this lasts.
  due(id);
  await deliver(id, down);
  expect(logged('audit.erase_blocked')).toHaveLength(2);

  due(id);
  await deliver(id, on);
  expect(kinds(await trail('acme'))).toEqual(['repo.created', 'repo.deleted']);
  expect(await erased(id)).toBe(true);
  expect(delayed.filter((m) => m.repo_id === id)).toEqual([]);
  expect(logged('audit.erase_blocked')).toHaveLength(2);
});

it('an erase with the erase switched off is held to the same limit', async () => {
  const who = await org('acme', 'audit_held_off');
  const id = await made(who, 'acme', 'app', noErase);
  quiet();
  const logged = alerts();
  const down = logDown(noErase);
  await api(`/repos/${id}?confirm=app`, who, { method: 'DELETE' }, down);
  await deliver(id, down);
  backdated(id, HOUR + 60_000);
  due(id);
  await deliver(id, down);
  expect(logged('audit.erase_blocked')).toHaveLength(1);
});

/** Puts `payload` in the outbox as a repository's next event, between good ones. */
const planted = (repo: string, payload: string) =>
  runInDurableObject(authority(repo), (_, state) => {
    const add = (body: string) =>
      state.storage.sql.exec<{ seq: number }>(
        "INSERT INTO hook_outbox(hook_id,event,payload) VALUES(0,'repo.visibility_changed',?) RETURNING seq",
        body,
      ).one().seq;
    const good = JSON.stringify({ visibility: 'public', name: 'app', actor: 'user:x', at: 5 });
    add(good);
    const seq = add(payload);
    add(good);
    return seq;
  });

it('a corrupt event is named at once, stays put, and holds the erase until it is mended', async () => {
  const who = await org('acme', 'audit_corrupt');
  const id = await made(who, 'acme');
  quiet();
  const logged = alerts();
  const secret = 'hunter2-not-for-any-log';
  const seq = await planted(id, `{"token":"${secret}"`);
  // A change on a live repository is what meets it first, and it isn't left waiting an hour.
  // Nor does a log that is down hide it.
  await api(`/repos/${id}/visibility`, who, { method: 'PUT', body: { visibility: 'public' } }, logDown());
  expect(logged('audit.event_corrupt').at(-1)).toMatchObject({ repo: id, seq });
  await api(`/repos/${id}/visibility`, who, { method: 'PUT', body: { visibility: 'private' } }, on);
  // What came before it reached the log; it and what follows it are all still here.
  expect(kinds(await trail('acme'))).toEqual(['repo.created', 'repo.visibility_changed']);
  expect(await waiting(id)).toBe(4);

  await api(`/repos/${id}?confirm=app`, who, { method: 'DELETE' }, on);
  await deliver(id, on);
  expect(await erased(id)).toBe(false);
  expect(await waiting(id)).toBe(5);
  expect(logged('audit.event_corrupt').at(-1)).toMatchObject({ repo: id, seq });
  const step = caller(on, id, { _system: 'erase' })({ op: 'repo_erase_step' });
  await expect(step).rejects.toMatchObject({ code: 'CONFLICT' });
  expect(JSON.stringify(logged('audit.event_corrupt'))).not.toContain('hunter2');

  // Mended, it goes through in order, and the erase with it.
  await runInDurableObject(authority(id), (_, state) => {
    const mended = JSON.stringify({ visibility: 'private', name: 'app', actor: 'user:x', at: 6 });
    state.storage.sql.exec('UPDATE hook_outbox SET payload=? WHERE seq=?', mended, seq);
  });
  expect(due(id)).toHaveLength(1);
  await deliver(id, on);
  expect(await trail('acme')).toHaveLength(7);
  expect(await erased(id)).toBe(true);
});

it('off, a corrupt row raises nothing and goes with the rest', async () => {
  const who = await org('acme', 'audit_corrupt_off');
  const id = await made(who, 'acme', 'app', logOff);
  const logged = alerts();
  await planted(id, 'not json');
  await api(`/repos/${id}?confirm=app`, who, { method: 'DELETE' }, logOff);
  await deliver(id, logOff);
  expect(await erased(id)).toBe(true);
  expect(logged('audit.event_corrupt')).toEqual([]);
  expect(logged('audit.erase_blocked')).toEqual([]);
});

