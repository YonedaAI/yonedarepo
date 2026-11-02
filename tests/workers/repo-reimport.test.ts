// Repositories made while Artifacts held Git objects. Their spec names a store that has gone,
// so each must read as the store of record does; and those whose history lived only there are
// found, and cloned again under the same id and name. R2 and the authority are real.
import { runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { operatorRepoHold } from '../../cloudflare/worker/platform-holds';
import { platformFetch } from '../../cloudflare/worker/platform-routes';
import { importAudit, reimportRepository } from '../../cloudflare/worker/repo-reimport';
import { caller } from '../../cloudflare/worker/repo-ops';
import { shardCall } from '../../cloudflare/worker/repo-shards';
import { parseStore } from '../../cloudflare/worker/repo-stores';
import type { Env } from '../../cloudflare/worker/types';
import { api, author, bindings, file, scoped, signup, usePlatformFixture } from './repo-fixture';
import { pkt } from './synthetic-pack';

usePlatformFixture();

const env = { ...scoped, PUSH_BUNDLES: 'on', PACK_CACHE: 'on' } as unknown as Env;
const policy = { required_checks: [], approvals: 0 };

/** Rewrites a repository's recorded store to one written before this one. */
async function storedAs(id: string, spec: string) {
  const stub = bindings.SOURCE_REPOS.get(bindings.SOURCE_REPOS.idFromName(id));
  await runInDurableObject(stub, (_: unknown, state: DurableObjectState) => {
    state.storage.sql.exec("UPDATE repo_settings SET object_store=? WHERE id='repository'", spec);
  });
}

async function sql(id: string, statement: string) {
  const stub = bindings.SOURCE_REPOS.get(bindings.SOURCE_REPOS.idFromName(id));
  await runInDurableObject(stub, (_: unknown, state: DurableObjectState) => {
    state.storage.sql.exec(statement);
  });
}

async function made(name: string, spec: (id: string) => string) {
  const owner = { cookie: await signup(`old_${name}`) };
  const created = await api('/repos', owner, { body: { name, policy, files: [file('a.txt', 'one\n')], author } }, env);
  expect(created.status).toBe(200);
  const id = created.body.id as string;
  await storedAs(id, spec(id));
  return { owner, id, repo: `/repos/${id}` };
}

describe('a repository whose spec names a store that has gone', () => {
  it.each([
    ['artifacts', (id: string) => `artifacts:yonedarepo-dev/yr-${id}`],
    ['another namespace', (id: string) => `artifacts:some-old-namespace/yr-${id}`],
    ['r2', (id: string) => `r2:yr-${id}`],
  ])('reads, commits, lands, clones and purges as ever on %s', async (name, spec) => {
    const { owner, id, repo } = await made(name.replace(/ /g, ''), spec);

    expect((await api(repo, owner, {}, env)).status).toBe(200);
    expect((await api(`${repo}/blob?ref=main&path=a.txt`, owner, {}, env)).body.content).toBe('one\n');
    const commit = await api(`${repo}/commits`, owner, { body: { ref: 'main', message: 'two', author, changes: [file('b.txt', 'two\n')] } }, env);
    expect(commit.status).toBe(200);
    expect((await api(`${repo}/land`, owner, { body: { ref: 'main', commit: commit.body.commit } }, env)).status).toBe(200);
    expect((await api(`${repo}/blob?ref=main&path=b.txt`, owner, {}, env)).body.content).toBe('two\n');
    const token = (await api(`${repo}/tokens`, owner, { body: { name: 'r', scopes: ['read'] } }, env)).body.token as string;
    const wanted = (await api(`${repo}/refs`, owner, {}, env)).body.refs['refs/heads/main'];
    const body = `${pkt('command=fetch\n')}${pkt('object-format=sha1\n')}0001${[`want ${wanted}`, 'ofs-delta', 'no-progress', 'done'].map((l) => pkt(`${l}\n`)).join('')}0000`;
    const clone = await platformFetch(new Request(`https://yoneda/git/${id}.git/git-upload-pack`, { method: 'POST', headers: { authorization: `Basic ${btoa(`git:${token}`)}`, 'git-protocol': 'version=2' }, body }), env);
    expect(clone.status).toBe(200);
    expect(new TextDecoder().decode(await clone.arrayBuffer())).not.toContain('ERR ');
  });

  it('forks from such a parent, whose spec the fork names', async () => {
    const { owner, repo } = await made('forked', (id) => `artifacts:yonedarepo-dev/yr-${id}`);
    const fork = await api(`${repo}/fork`, owner, { body: { name: 'child' } }, env);
    expect(fork.status).toBe(200);
    const read = await api(`/repos/${fork.body.id}/blob?ref=main&path=a.txt`, owner, {}, env);
    expect(read.body.content).toBe('one\n');
  });

  it('never throws on any spec a deployment has written', () => {
    for (const spec of ['artifacts:ns/yr-rabc', 'artifacts:ns/plain-name', 'r2:yr-rabc', 'r2:plain-name', 'platform:rabc'])
      expect(parseStore(env, spec).spec).toMatch(/^platform:/);
  });

  it('answers a missing object as missing, not as a failure, where only the old store held it', async () => {
    const { owner, repo, id } = await made('missing', (i) => `artifacts:ns/yr-${i}`);
    await env.OBJECTS.delete((await env.OBJECTS.list({ prefix: `platform/v1/${id}/` })).objects.map((o) => o.key));
    const read = await api(`${repo}/blob?ref=main&path=gone.txt`, owner, {}, env);
    expect(read.status).toBe(404);
  });
});

describe('finding what needs a re-import', () => {
  const page = async () => {
    const seen: any[] = [];
    let after: string | undefined;
    for (;;) {
      const answer = await importAudit(env, after);
      seen.push(...answer.repositories);
      if (!answer.next) return seen;
      after = answer.next;
    }
  };

  it('names a repository with imported history, and passes one that never had any', async () => {
    const clean = await made('clean', (id) => `artifacts:ns/yr-${id}`);
    const imported = await made('imported', (id) => `artifacts:ns/yr-${id}`);
    await sql(imported.id, "UPDATE commits SET origin='import'");

    const seen = await page();

    const of = (id: string) => seen.find((r) => r.id === id);
    expect(of(clean.id)).toMatchObject({ name: 'clean', needs: 'nothing', head_readable: true });
    expect(of(imported.id)).toMatchObject({ name: 'imported', needs: 'reimport', imported_commits: 1 });
  });

  it('flags a commit that went whole to the old store, only where that store was the old one', async () => {
    const old = await made('whole', (id) => `artifacts:ns/yr-${id}`);
    const fresh = await made('fresh', (id) => `platform:${id}`);
    for (const { id } of [old, fresh]) await sql(id, "UPDATE commits SET origin='platform',hidden_ref=1");

    const seen = await page();

    expect(seen.find((r) => r.id === old.id).needs).toBe('check');
    expect(seen.find((r) => r.id === fresh.id).needs).toBe('nothing');
  });

  it('says so when main cannot be read back from the store of record', async () => {
    const { id } = await made('unreadable', (i) => `artifacts:ns/yr-${i}`);
    await sql(id, `UPDATE commits SET tree='${'a'.repeat(40)}'`);

    const seen = await page();

    expect(seen.find((r) => r.id === id)).toMatchObject({ head_readable: false, needs: 'reimport' });
  });
});

describe('a re-import', () => {
  const workflows = (status = 'complete') => {
    const created: any[] = [];
    return { created, create: async (o: any) => (created.push(o), { id: o.id }), get: async () => ({ status: async () => ({ status }) }) };
  };

  it('tells what it would do and touches nothing, unless confirmed', async () => {
    const { owner, repo, id } = await made('dry', (i) => `artifacts:ns/yr-${i}`);
    const PLATFORM_IMPORT = workflows();
    const target = { ...env, PLATFORM_IMPORT } as unknown as Env;

    const answer = await reimportRepository(target, 'operator', id, { url: 'https://github.com/acme/src.git' });

    expect(answer).toMatchObject({ dry_run: true, url: 'https://github.com/acme/src.git', name: 'dry' });
    expect(PLATFORM_IMPORT.created).toEqual([]);
    expect((await api(`${repo}/refs`, owner, {}, env)).body.refs['refs/heads/main']).toBeTruthy();
  });

  it('keeps the id, name and tokens, empties history and starts a clone, each run a new instance', async () => {
    const { owner, repo, id } = await made('again', (i) => `artifacts:ns/yr-${i}`);
    const token = (await api(`${repo}/tokens`, owner, { body: { name: 'stays', scopes: ['read'] } }, env)).body.token as string;
    await env.OBJECTS.put(`platform/v1/${id}/checks/kept.log`, 'stays');
    const PLATFORM_IMPORT = workflows();
    const target = { ...env, PLATFORM_IMPORT } as unknown as Env;

    const answer = await reimportRepository(target, 'operator', id, { url: 'https://github.com/acme/src', confirm: true });

    expect(answer).toMatchObject({ id, name: 'again', url: 'https://github.com/acme/src.git' });
    const status = await api(repo, { token }, {}, target);
    expect(status.status).toBe(200);
    expect(status.body.name).toBe('again');
    expect(status.body.object_store).toBe(`platform:${id}`);
    expect((await api(`${repo}/refs`, { token }, {}, target)).body.refs).toEqual({});
    expect(await env.OBJECTS.get(`platform/v1/${id}/checks/kept.log`)).not.toBeNull();
    expect((await env.OBJECTS.list({ prefix: `platform/v1/${id}/git/` })).objects).toEqual([]);
    expect(PLATFORM_IMPORT.created).toHaveLength(1);
    expect(PLATFORM_IMPORT.created[0].params).toMatchObject({ repo: id, url: 'https://github.com/acme/src.git' });

    await reimportRepository(target, 'operator', id, { url: 'https://github.com/acme/src', confirm: true });

    expect(new Set(PLATFORM_IMPORT.created.map((c) => c.id)).size).toBe(2);
    const look = await api(`${repo}/import`, owner, {}, target);
    expect(look.body).toMatchObject({ import: PLATFORM_IMPORT.created[1].id, status: 'complete' });
  });

  it('leaves the commit shards usable: an erased shard is sealed for good', async () => {
    const { id } = await made('shards', (i) => `artifacts:ns/yr-${i}`);
    const target = { ...env, PLATFORM_IMPORT: workflows() } as unknown as Env;

    await reimportRepository(target, 'operator', id, { url: 'https://github.com/acme/src', confirm: true });

    await expect(shardCall(env, id, 0, { op: 'store_objects_pending' })).resolves.toBeDefined();
  });

  it('waits for an import that is still running', async () => {
    const { id } = await made('busy', (i) => `artifacts:ns/yr-${i}`);
    const target = { ...env, PLATFORM_IMPORT: workflows('running') } as unknown as Env;

    await expect(reimportRepository(target, 'operator', id, { url: 'https://github.com/acme/src', confirm: true })).rejects.toMatchObject({ code: 'CONFLICT' });

    expect((await caller(env, id, { _system: 'import' })({ op: 'repo_store_audit' })).commits).toBe(1);
  });

  it('takes the address the import recorded when none is given', async () => {
    const { id } = await made('recorded', (i) => `artifacts:ns/yr-${i}`);
    await env.OBJECTS.put(`platform/v1/${id}/import-asked.json`, JSON.stringify({ repo: id, url: 'https://github.com/acme/kept.git' }));
    const target = { ...env, PLATFORM_IMPORT: workflows() } as unknown as Env;

    const answer = await reimportRepository(target, 'operator', id, {});

    expect(answer).toMatchObject({ dry_run: true, url: 'https://github.com/acme/kept.git' });
  });

  it('refuses an address that is not a public GitHub repository, and one it cannot know', async () => {
    const { id } = await made('badurl', (i) => `artifacts:ns/yr-${i}`);
    await expect(reimportRepository(env, 'operator', id, { url: 'http://github.com/a/b' })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(reimportRepository(env, 'operator', id, {})).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });

  it('refuses a fork, which reads its parent', async () => {
    const { owner, repo } = await made('parent', (i) => `artifacts:ns/yr-${i}`);
    const fork = await api(`${repo}/fork`, owner, { body: { name: 'its-fork' } }, env);

    await expect(reimportRepository(env, 'operator', fork.body.id, { url: 'https://github.com/acme/src' })).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('is refused under a legal hold, and history stays', async () => {
    const { id } = await made('held', (i) => `artifacts:ns/yr-${i}`);
    const held = { ...env, LEGAL_HOLD: 'on', PLATFORM_IMPORT: workflows() } as unknown as Env;
    await operatorRepoHold(held, 'operator', id, 'POST');

    await expect(reimportRepository(held, 'operator', id, { url: 'https://github.com/acme/src', confirm: true })).rejects.toMatchObject({ code: 'LEGAL_HOLD' });

    expect((await caller(env, id, { _system: 'import' })({ op: 'repo_store_audit' })).commits).toBe(1);
  });
});
