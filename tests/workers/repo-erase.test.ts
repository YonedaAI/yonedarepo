// Erasing a deleted repository in the real Durable Objects (REPO_ERASE=on): after the purge
// job the authority's records go in batches, its commit shards and combiners are cleared, and
// a tombstone keeps answering GONE. Off, nothing of this runs.
import { runInDurableObject } from 'cloudflare:test';
import { expect, it, vi } from 'vitest';
import { platformJob } from '../../cloudflare/worker/platform-entrypoint';
import { purgeRepository } from '../../cloudflare/worker/repo-admin';
import { backfillObject, eraseJob } from '../../cloudflare/worker/repo-erase';
import { deliverHook } from '../../cloudflare/worker/repo-hooks';
import { LandCombiner } from '../../cloudflare/worker/repo-land-combiner';
import { caller } from '../../cloudflare/worker/repo-ops';
import { SHARDS, shardCall } from '../../cloudflare/worker/repo-shards';
import type { Env } from '../../cloudflare/worker/types';
import { api, author, bindings, delayed, drainObjects, erasedCombiners, file, queued, scoped, signup, usePlatformFixture } from './repo-fixture';

usePlatformFixture();

const off = { ...scoped } as unknown as Env;
const on = { ...off, REPO_ERASE: 'on' } as unknown as Env;

/** Runs `repo`'s queued purge and erase jobs, like the consumer, until none is left. */
async function drain(repo: string, target: Env = on) {
  for (let turn = 0; turn < 100; turn++) {
    const at = queued.findIndex((m) => ['platform_purge', 'platform_erase'].includes(m.kind) && m.repo_id === repo);
    if (at < 0) return;
    const [body] = queued.splice(at, 1);
    await platformJob(target, { body, attempts: 1, ack() {}, retry() {} } as unknown as Message<any>);
  }
  throw new Error('the jobs never finished');
}

/** Stored as a search index, a pack, symbols and facts are: file content. */
async function derived(repo: string) {
  const keys = ['search/index', 'packs/v2/abc', 'symbols/v1/ts/abc', 'facts/v1/abc'].map((k) => `derived/v1/${repo}/${k}`);
  await Promise.all(keys.map((key) => bindings.OBJECTS.put(key, 'hunter2')));
  return keys;
}
const stored = async (prefix: string) => (await bindings.OBJECTS.list({ prefix })).objects.map((o) => o.key);

/** Delivers one queued job as the queue does, reporting how it settled. */
async function deliver(body: any, target: Env = on) {
  let settled = 'unsettled';
  await platformJob(target, { body, attempts: 2, ack: () => void (settled = 'ack'), retry: () => void (settled = 'retry') } as unknown as Message<any>);
  return settled;
}

const authority = (repo: string) => bindings.SOURCE_REPOS.get(bindings.SOURCE_REPOS.idFromName(repo));
const shard = (repo: string, n: number) => bindings.COMMIT_SHARDS.get(bindings.COMMIT_SHARDS.idFromName(`${repo}:${n}`));

/** A table's rows, read inside the object. */
const rows = (stub: DurableObjectStub, sql: string) =>
  runInDurableObject(stub, (_: unknown, state: DurableObjectState) => state.storage.sql.exec(sql).toArray());
const count = async (repo: string, table: string) =>
  Number((await rows(authority(repo), `SELECT COUNT(*) AS n FROM ${table}`))[0].n);
const size = (repo: string) =>
  runInDurableObject(authority(repo), (_: unknown, state: DurableObjectState) => state.storage.sql.databaseSize);

/** A repository with a landed history, a session record, a change and a memory. */
async function filled(who: { cookie: string }, name: string, target: Env = on) {
  const created = await api('/repos', who, { body: { name, files: [file('secrets/plan.md', 'hunter2\n')], author } }, target);
  expect(created.status, JSON.stringify(created.body)).toBe(200);
  const id = created.body.id as string;
  await drainObjects(target);
  await runInDurableObject(authority(id), (_: unknown, state: DurableObjectState) => {
    const sql = state.storage.sql;
    sql.exec(`INSERT INTO sessions(commit_id,cli,summary,recorded_by,at) VALUES('c','cli','hunter2','a',1)`);
    sql.exec(`INSERT INTO changes(title,body,branch,author,status,created_at,updated_at) VALUES('hunter2','hunter2','x','a','open',1,1)`);
    sql.exec(`INSERT INTO memories(kind,body,commit_id,author,recorded_at,recorded_version) VALUES('howto','hunter2','c','a',1,1)`);
    sql.exec(`INSERT INTO memory_text(rowid,body) VALUES(1,'hunter2')`);
    // Enough paths for several batches, with their full-text rows.
    sql.exec(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<7000)
      INSERT INTO commit_paths(commit_id,path,op) SELECT 'c','src/hunter2/file'||i||'.rs','add' FROM n`);
  });
  return id;
}

const remove = (who: { cookie: string }, id: string, name: string, target: Env = on) =>
  api(`/repos/${id}?confirm=${name}`, who, { method: 'DELETE' }, target);

it('changes nothing while REPO_ERASE is off', async () => {
  const who = { cookie: await signup('erase_off') };
  const id = await filled(who, 'kept', off);
  const keys = await derived(id);
  expect((await remove(who, id, 'kept', off)).status).toBe(200);
  await drain(id, off);
  // Derived caches hold file content, so purge takes them with the switch off too.
  expect(await stored(`derived/v1/${id}/`)).toEqual([]);
  expect(queued.filter((m) => m.kind === 'platform_erase')).toEqual([]);
  expect(await count(id, 'commits')).toBeGreaterThan(0);
  expect(await count(id, 'commit_paths')).toBe(7000 + 1);
  // A job left in the queue when the switch went off does nothing either.
  await eraseJob(off, { v: 1, kind: 'platform_erase', repo_id: id, job_id: 'start' });
  expect(await count(id, 'commit_paths')).toBe(7000 + 1);
});

it('erases the records after the purge, keeps GONE and frees the name', async () => {
  const who = { cookie: await signup('erase_on') };
  const id = await filled(who, 'doomed');
  const before = await size(id);
  expect((await remove(who, id, 'doomed')).status).toBe(200);
  await drain(id);

  for (const table of ['commits', 'commit_paths', 'txlog', 'refs', 'tokens', 'sessions', 'changes', 'memories', 'commit_text', 'commit_path_text', 'session_text', 'change_text', 'memory_text'])
    expect(await count(id, table), table).toBe(0);
  const after = await size(id);
  expect(after, `${before} to ${after}`).toBeLessThan(before / 2);
  // Terms leave the indexes too, and no search can find them.
  for (const index of ['commit_path_text', 'session_text', 'change_text', 'memory_text']) {
    const stub = authority(id);
    expect((await rows(stub, `SELECT COUNT(*) AS n FROM ${index} WHERE ${index} MATCH 'hunter2'`))[0].n, index).toBe(0);
    expect(await count(id, `${index}_docsize`), index).toBe(0);
  }
  const [settings] = await rows(authority(id), 'SELECT * FROM repo_settings');
  expect(JSON.stringify(settings)).not.toContain('doomed');
  expect(settings).toMatchObject({ name: '', workspace: '', owner: '', object_store: 'erased', visibility: 'private' });
  expect(settings.deleted_at).toBeTypeOf('number');

  for (const path of [`/repos/${id}`, `/repos/${id}/refs`, `/repos/${id}/log`, `/repos/${id}/tree?path=`]) {
    const gone = await api(path, who, {}, on);
    expect([gone.status, gone.body.error?.code], path).toEqual([404, 'GONE']);
  }
  expect((await remove(who, id, 'doomed')).body.error.code).toBe('GONE');
  // Its name is free for a new repository, which works as any other.
  const again = await api('/repos', who, { body: { name: 'doomed', files: [file('a.md', 'new\n')], author } }, on);
  expect(again.status, JSON.stringify(again.body)).toBe(200);
  expect(again.body.id).not.toBe(id);
  expect((await api(`/repos/${again.body.id}/refs`, who, {}, on)).status).toBe(200);
});

it('clears every commit shard and seals it, and a woken shard recreates nothing', async () => {
  const who = { cookie: await signup('erase_shards') };
  const id = await filled(who, 'shards');
  await shardCall(on, id, 3, { op: 'store_status' });
  await runInDurableObject(shard(id, 3), (_: unknown, state: DurableObjectState) => {
    state.storage.sql.exec(`INSERT INTO commits(id,tree,parents,generation,base_version,principal,message,read_set,recorded_at)
      VALUES('c','t','[]',1,0,'a','hunter2','[]',1)`);
  });
  expect((await remove(who, id, 'shards')).status).toBe(200);
  await drain(id);

  for (const n of [0, 3, SHARDS - 1]) {
    const tables = () => rows(shard(id, n), `SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE '\\_cf%' ESCAPE '\\' AND name NOT LIKE 'sqlite_%'`);
    expect(await tables(), `shard ${n}`).toEqual([]);
    // A straggler job or a read on the tombstone wakes it: GONE, and no schema comes back.
    for (const command of [{ op: 'store_status' }, { op: 'store_objects_pending' }, { op: 'store_commit', commit: 'c'.repeat(40) }])
      await expect(shardCall(on, id, n, command)).rejects.toMatchObject({ code: 'GONE' });
    expect(await tables(), `shard ${n} woken`).toEqual([]);
  }
  // Clearing again (a retried job) still answers.
  expect((await shardCall(on, id, 3, { op: 'store_erase' })).erased).toBe(true);
  const status = await api(`/repos/${id}`, who, {}, on);
  expect([status.status, status.body.error?.code]).toEqual([404, 'GONE']);
});

it('deletes the derived caches, which hold file content, only for that repository', async () => {
  const who = { cookie: await signup('erase_derived') };
  const id = await filled(who, 'derives');
  const other = await filled(who, 'neighbour');
  await derived(id);
  const kept = await derived(other);
  expect((await remove(who, id, 'derives')).status).toBe(200);
  await drain(id);
  expect(await stored(`derived/v1/${id}/`)).toEqual([]);
  expect((await stored(`derived/v1/${other}/`)).sort()).toEqual([...kept].sort());
});

it('starts the wipe from the purge itself, once, after the objects are gone', async () => {
  const who = { cookie: await signup('erase_attach') };
  const id = await filled(who, 'attached');
  expect((await remove(who, id, 'attached')).status).toBe(200);
  await purgeRepository(on, id);
  expect(queued.filter((m) => m.kind === 'platform_erase' && m.repo_id === id).map((m) => m.job_id)).toEqual(['start']);
  // The purge alone wipes nothing.
  expect(await count(id, 'commits')).toBeGreaterThan(0);
  // The job purges again without starting another job, or it would never end.
  const [start] = queued.splice(queued.findIndex((m) => m.kind === 'platform_erase'), 1);
  await eraseJob(on, start);
  expect(queued.filter((m) => m.kind === 'platform_erase' && m.repo_id === id)).toEqual([]);
  expect(await count(id, 'commits')).toBe(0);
});

it('settles a purge job delivered again after the wipe', async () => {
  const who = { cookie: await signup('erase_replay') };
  const id = await filled(who, 'replayed');
  expect((await remove(who, id, 'replayed')).status).toBe(200);
  const purge = queued.find((m) => m.kind === 'platform_purge' && m.repo_id === id);
  await drain(id);
  expect((await rows(authority(id), 'SELECT object_store FROM repo_settings'))[0].object_store).toBe('erased');

  const target = await caller(on, id, { _system: 'purge' })({ op: 'repo_purge_target' });
  expect(target.object_store).toBe('erased');
  expect(await deliver(purge)).toBe('ack');
  // The wipe it starts again finds nothing to do and stops.
  expect(await deliver(queued.find((m) => m.kind === 'platform_erase' && m.repo_id === id))).toBe('ack');
  queued.splice(0, queued.length, ...queued.filter((m) => m.kind !== 'platform_erase'));
  expect((await rows(authority(id), 'SELECT object_store FROM repo_settings'))[0].object_store).toBe('erased');
});

it('tells a revoked token GONE after the wipe, as managed cleanup needs', async () => {
  const who = { cookie: await signup('erase_managed') };
  const created = await api('/repos', who, { body: { name: 'managed', files: [file('a.md', 'a\n')], author, tokens: [{ name: 'managed', scopes: ['read'] }] } }, on);
  const id = created.body.id as string;
  const token = { token: created.body.tokens[0].token as string };
  expect((await api(`/repos/${id}`, token, {}, on)).status).toBe(200);
  expect((await remove(who, id, 'managed')).status).toBe(200);
  await drain(id);
  expect(await count(id, 'tokens')).toBe(0);
  // Not NOT_FOUND or UNAUTHORIZED: the managed Worker clears a repository's reviews on GONE
  // alone, and its token is the only credential it has.
  const gone = await api(`/repos/${id}`, token, {}, on);
  expect([gone.status, gone.body.error?.code]).toEqual([404, 'GONE']);
});

it('leaves a live repository and its shards alone, whatever a job asks', async () => {
  const who = { cookie: await signup('erase_live') };
  const id = await filled(who, 'live');
  await eraseJob(on, { v: 1, kind: 'platform_erase', repo_id: id, job_id: 'start' });
  await eraseJob(on, { v: 1, kind: 'platform_erase', repo_id: id, job_id: 'wipe' }).catch((e) => expect(e.code).toBe('NOT_FOUND'));
  expect((await api(`/repos/${id}/refs`, who, {}, on)).status).toBe(200);
  expect(await count(id, 'commit_paths')).toBe(7001);
  expect((await shardCall(on, id, 0, { op: 'store_status' })).pending).toBe(0);
});

it('clears the head holder, the projector and a combiner per ref, as either spelling', async () => {
  const who = { cookie: await signup('erase_combiners') };
  const id = await filled(who, 'combined');
  await caller(on, id, { _system: 'merge' })({ op: 'repo_refs' });
  expect((await remove(who, id, 'combined')).status).toBe(200);
  erasedCombiners.length = 0;
  await drain(id);
  for (const name of [`${id}#head`, `${id}#projector`, `${id}:refs/heads/main`, `${id}:main`])
    expect(erasedCombiners, name).toContain(name);
});

it('empties a real combiner: its persisted target, projector and alarm', async () => {
  const namespace = bindings.LAND_COMBINERS as DurableObjectNamespace<LandCombiner>;
  const stub = namespace.get(namespace.idFromName('rdeadbeefdeadbeefdead:main'));
  await runInDurableObject(stub, async (combiner: LandCombiner, state: DurableObjectState) => {
    await state.storage.put('target', { repo: 'rdeadbeefdeadbeefdead', ref: 'main' });
    await state.storage.put('projector', 'rdeadbeefdeadbeefdead');
    await state.storage.setAlarm(Date.now() + 3_600_000);
    await combiner.erase();
    expect((await state.storage.list()).size).toBe(0);
    expect(await state.storage.getAlarm()).toBeNull();
    // Woken by a fired alarm with nothing to do, it writes nothing.
    await combiner.alarm();
    expect((await state.storage.list()).size).toBe(0);
  });
});

it('resumes after a crash mid-erase', async () => {
  const who = { cookie: await signup('erase_crash') };
  const id = await filled(who, 'crashes');
  expect((await remove(who, id, 'crashes')).status).toBe(200);
  // The second step's reply is lost, once: the step ran, its job failed and is retried.
  let steps = 0;
  const repos = bindings.SOURCE_REPOS;
  const flaky = {
    ...on,
    SOURCE_REPOS: {
      idFromName: (name: string) => repos.idFromName(name),
      get: (doId: DurableObjectId) => {
        const stub = repos.get(doId);
        return {
          fetch: async (url: string, init: RequestInit) => {
            const response = await stub.fetch(url, init);
            if (String(init.body).includes('repo_erase_step') && ++steps === 2) throw new Error('crashed');
            return response;
          },
        };
      },
    },
  } as unknown as Env;
  const job = { v: 1 as const, kind: 'platform_erase', repo_id: id, job_id: 'start' };
  await expect(eraseJob(flaky, job)).rejects.toThrow('crashed');
  const left = await count(id, 'commit_paths');
  expect(left).toBeGreaterThan(0);
  expect(left).toBeLessThan(7001);
  expect((await rows(authority(id), 'SELECT object_store FROM repo_settings'))[0].object_store).not.toBe('erased');
  expect((await api(`/repos/${id}`, who, {}, on)).body.error.code).toBe('GONE');
  // The queue redelivers the same job.
  await eraseJob(flaky, job);
  await drain(id);
  expect(await count(id, 'commit_paths')).toBe(0);
  expect((await rows(authority(id), 'SELECT object_store FROM repo_settings'))[0].object_store).toBe('erased');
});

it('continues a long erase in fresh jobs, each with a bounded number of steps', async () => {
  const who = { cookie: await signup('erase_long') };
  const id = await filled(who, 'long');
  await runInDurableObject(authority(id), (_: unknown, state: DurableObjectState) => {
    state.storage.sql.exec(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<205000)
      INSERT INTO txlog_paths(version,refname,path) SELECT i,'refs/heads/main','p'||i FROM n`);
  });
  expect((await remove(who, id, 'long')).status).toBe(200);
  const jobs = vi.spyOn(console, 'log');
  await drain(id);
  expect(await count(id, 'txlog_paths')).toBe(0);
  const lines = jobs.mock.calls.map(([line]) => String(line)).filter((line) => line.includes('repo.erase'));
  expect(lines.map((line) => JSON.parse(line).phase)).toEqual(['objects', 'records', 'erased']);
  // Progress is counts and ids, never a name or a path.
  for (const line of lines) expect(line).not.toMatch(/hunter2|long"/);
});

it('delivers repo.deleted from the tombstone before erasing it', async () => {
  const who = { cookie: await signup('erase_hooks') };
  const id = await filled(who, 'hooked');
  const hook = await api(`/repos/${id}/hooks`, who, { body: { url: 'https://managed.example.com/hooks/x', events: ['repo'] } }, on);
  expect(hook.status).toBe(200);
  expect((await remove(who, id, 'hooked')).status).toBe(200);
  const held = delayed.length;
  await drain(id);
  // Held back: nothing is erased, delivery is sent again and the job comes back later.
  expect(await count(id, 'commits')).toBeGreaterThan(0);
  expect(await count(id, 'hooks')).toBe(1);
  expect(delayed.slice(held).map((m) => [m.kind, m.job_id])).toEqual([['platform_erase', 'start']]);
  expect(queued.filter((m) => m.kind === 'platform_hooks' && m.repo_id === id).map((m) => m.job_id)).toContain(`hook:${hook.body.id}`);

  const sent: string[] = [];
  await deliverHook(on, id, hook.body.id, async (request) => {
    sent.push((await request.json<{ event: string }>()).event);
    return new Response(null, { status: 202 });
  });
  expect(sent).toEqual(['repo.deleted']);
  queued.push(...delayed.splice(held));
  await drain(id);
  expect(await count(id, 'commits')).toBe(0);
  expect(await count(id, 'hooks')).toBe(0);
  // A delivery job still in the queue finds nothing, and ends.
  await deliverHook(on, id, hook.body.id, async () => {
    throw new Error('nothing should be sent');
  }).catch((e) => expect(e.code).toBe('GONE'));
});

it('erases a fork without touching its parent, and a parent never while a fork lives', async () => {
  const alice = { cookie: await signup('erase_alice') };
  const bob = { cookie: await signup('erase_bob') };
  const created = await api('/repos', alice, { body: { name: 'upstream', visibility: 'public', policy: { approvals: 0, required_checks: [] }, files: [file('a.md', 'parent\n')], author } }, on);
  const parent = created.body.id as string;
  await drainObjects(on);
  const forked = await api(`/repos/${parent}/fork`, bob, { body: { name: 'mine' } }, on);
  expect(forked.status, JSON.stringify(forked.body)).toBe(200);
  const fork = forked.body.id as string;
  await drainObjects(on);
  const read = async (repo: string, who: { cookie: string }) =>
    (await api(`/repos/${repo}/blob?path=a.md`, who, {}, on)).body.content;

  // The parent refuses, so nothing can queue its erase; asked anyway, a job finds it live.
  expect((await remove(alice, parent, 'upstream')).status).toBe(409);
  await eraseJob(on, { v: 1, kind: 'platform_erase', repo_id: parent, job_id: 'start' });
  // The live fork still reads what it inherits from the parent's store.
  expect(await read(fork, bob)).toBe('parent\n');

  expect((await remove(bob, fork, 'mine')).status).toBe(200);
  await drain(fork);
  expect((await rows(authority(fork), 'SELECT object_store FROM repo_settings'))[0].object_store).toBe('erased');
  expect(await read(parent, alice)).toBe('parent\n');
  expect(await count(parent, 'commits')).toBeGreaterThan(0);
  expect(await count(parent, 'forks')).toBe(0);
  // Its last fork gone, the parent goes the same way.
  expect((await remove(alice, parent, 'upstream')).status).toBe(200);
  await drain(parent);
  expect(await count(parent, 'commits')).toBe(0);
});

it('runs the backfill for operators only', async () => {
  const operator = await signup('erase_operator');
  const user = await signup('erase_user');
  const target = { ...on, ADMIN_ACCOUNTS: 'erase_operator' } as unknown as Env;
  const body = { object: bindings.SOURCE_REPOS.newUniqueId().toString(), dry_run: true };
  expect((await api('/admin/erase-backfill', { cookie: user }, { body }, target)).status).toBe(403);
  const asked = await api('/admin/erase-backfill', { cookie: operator }, { body }, target);
  expect([asked.status, asked.body]).toEqual([200, { state: 'empty' }]);
});

it('backfills by object id: a dry run changes nothing, a real run queues the purge', async () => {
  const who = { cookie: await signup('erase_backfill') };
  const id = await filled(who, 'old', off);
  const live = await filled(who, 'alive', off);
  expect((await remove(who, id, 'old', off)).status).toBe(200);
  await drain(id, off);
  const object = bindings.SOURCE_REPOS.idFromName(id).toString();
  const operator = 'operator';

  const dry = await backfillObject(on, operator, { object, dry_run: true });
  expect(dry).toMatchObject({ state: 'tombstone', repo: id });
  expect(dry.db_bytes).toBeGreaterThan(0);
  expect(queued.filter((m) => m.repo_id === id && m.kind === 'platform_purge')).toEqual([]);
  expect(await count(id, 'commits')).toBeGreaterThan(0);

  expect((await backfillObject(on, operator, { object: bindings.SOURCE_REPOS.idFromName(live).toString() })).state).toBe('live');
  expect(queued.filter((m) => m.repo_id === live && m.kind === 'platform_purge')).toEqual([]);
  const unused = bindings.SOURCE_REPOS.newUniqueId().toString();
  expect((await backfillObject(on, operator, { object: unused })).state).toBe('empty');
  await expect(backfillObject(on, operator, { object: 'nonsense' })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  await expect(backfillObject(off, operator, { object })).rejects.toMatchObject({ code: 'CONFLICT' });

  expect((await backfillObject(on, operator, { object })).state).toBe('queued');
  await drain(id);
  expect(await count(id, 'commits')).toBe(0);
  // Repeating it is a no-op: the plan says it is done.
  expect((await backfillObject(on, operator, { object })).state).toBe('erased');
  expect(queued.filter((m) => m.repo_id === id && m.kind === 'platform_purge')).toEqual([]);
});
