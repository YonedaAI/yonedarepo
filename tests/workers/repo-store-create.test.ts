// With ASYNC_STORE on, a create never waits for Artifacts: the authority, the store of record
// and the outboxes serve the new repository, and a queue job creates its mirror. Artifacts is
// faked at its binding, faithfully to its contract: `get` of a repository that does not exist
// yet throws NOT_FOUND (CREATE_IN_PROGRESS while one is being made).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { platformJob } from '../../cloudflare/worker/platform-entrypoint';
import { STORE_JOB, STORE_WAIT_MS } from '../../cloudflare/worker/repo-artifacts-store';
import { parseStore } from '../../cloudflare/worker/repo-stores';
import { STORE_JOB_ATTEMPT_MS } from '../../cloudflare/worker/repo-store-create';
import { platformFetch } from '../../cloudflare/worker/platform-routes';
import type { Env, Envelope } from '../../cloudflare/worker/types';
import { api, author, delayed, fakeArtifacts, fakeQueue, file, pushes, queued, scoped, signup, usePlatformFixture } from './repo-fixture';

usePlatformFixture();

const coded = (code: string) => Object.assign(new Error(`Artifacts: ${code}`), { code });
const stalled = () => new Promise<never>(() => {});
const seed = (name: string) => ({ name, policy: { required_checks: [], approvals: 0 }, files: [file('README.md', `# ${name}\n`)], author, tokens: [{ name: 'ci', scopes: ['read'] }] });
const empty = (name: string) => ({ name, policy: { required_checks: [], approvals: 0 } });
const phases = (headers: Headers) => (headers.get('server-timing') ?? '').split(', ').map((entry) => entry.split(';')[0]);
const names = async (cookie: string, env: Env) => (await api('/repos', { cookie }, {}, env)).body.repos.map((r: any) => r.name);

/** Artifacts where only what `create` made exists; `making` runs before a create lands. */
function lazyStores(making: (name: string) => Promise<unknown> = async () => {}, absent = 'NOT_FOUND') {
  const made = new Set<string>();
  const forked: string[] = [];
  const create = vi.fn(async (name: string) => {
    if (made.has(name)) throw coded('ALREADY_EXISTS');
    await making(name);
    made.add(name);
    return { name };
  });
  const get = vi.fn(async (name: string) => {
    if (!made.has(name)) throw coded(absent);
    return { ...(await fakeArtifacts.get(name)), fork: async (to: string) => void forked.push(to) };
  });
  const env = { ...scoped, ASYNC_STORE: 'on', ARTIFACTS: { ...fakeArtifacts, create, get } } as unknown as Env;
  return { env, made, forked, create, get };
}

/** Delivers the queued jobs of `kind` like the consumer; answers how each settled. */
async function deliver(env: Env, kind: string) {
  const jobs = queued.filter((m) => m.kind === kind);
  queued.splice(0, queued.length, ...queued.filter((m) => m.kind !== kind));
  const messages = jobs.map((body) => ({ body, attempts: 1, ack: vi.fn(), retry: vi.fn() }));
  for (const message of messages) await platformJob(env, message as unknown as Message<Envelope>);
  return messages;
}

const storeJobs = () => queued.filter((m) => m.kind === STORE_JOB).map((m) => m.repo_id);

/** A v2 Git request, as `git clone` sends it, against `env`. */
async function clone(env: Env, repo: string, token: string, commit: string) {
  const pkt = (line: string) => `${(line.length + 4).toString(16).padStart(4, '0')}${line}`;
  const body = `${pkt('command=fetch\n')}${pkt('object-format=sha1\n')}0001${pkt(`want ${commit}\n`)}${pkt('done\n')}0000`;
  const response = await platformFetch(
    new Request(`https://yoneda/git/${repo}.git/git-upload-pack`, {
      method: 'POST',
      headers: { authorization: `Basic ${btoa(`git:${token}`)}`, 'git-protocol': 'version=2' },
      body,
    }),
    env,
  );
  expect(response.status).toBe(200);
  const bytes = new Uint8Array(await response.arrayBuffer());
  const at = new TextDecoder('latin1').decode(bytes).indexOf('PACK');
  return at < 0 ? 0 : new DataView(bytes.buffer, bytes.byteOffset + at + 8, 4).getUint32(0);
}

describe('a create with a stalled store', () => {
  it('answers without asking Artifacts, and leaves a job to create the store', async () => {
    const { env, create } = lazyStores(stalled);
    const owner = { cookie: await signup('quick') };
    const created = await api('/repos', owner, { body: seed('quick') }, env);
    expect(created.status, JSON.stringify(created.body)).toBe(200);
    expect(create).not.toHaveBeenCalled();
    expect(phases(created.headers)).not.toContain('create.store');
    expect(storeJobs()).toEqual([created.body.id]);
    expect(await names(owner.cookie, env)).toEqual(['quick']);
  });

  it('takes back a create whose job could not be queued, so the same name works', async () => {
    const { env } = lazyStores();
    const owner = { cookie: await signup('unqueued') };
    const down = { ...env, PLATFORM_QUEUE: { ...fakeQueue, send: async (message: any) => {
      if (message.kind === STORE_JOB) throw new Error('internal error; reference = abc123');
      return fakeQueue.send(message);
    } } } as unknown as Env;
    const refused = await api('/repos', owner, { body: seed('unqueued') }, down);
    expect(refused.status).toBe(503);
    expect(refused.body.error.code).toBe('CREATE_UNAVAILABLE');
    expect(await names(owner.cookie, env)).toEqual([]);
    expect(queued.filter((m) => m.kind === 'platform_purge')).toHaveLength(1);
    expect((await api('/repos', owner, { body: seed('unqueued') }, env)).status).toBe(200);
  });

  it('keeps creating in the request on the R2 store, which has nothing to wait for', async () => {
    const env = { ...scoped, ASYNC_STORE: 'on', PLATFORM_OBJECT_STORE: 'r2' } as unknown as Env;
    const owner = { cookie: await signup('rtwo') };
    const created = await api('/repos', owner, { body: seed('rtwo') }, env);
    expect(created.status, JSON.stringify(created.body)).toBe(200);
    expect(storeJobs()).toEqual([]);
  });
});

describe('the store job', () => {
  it('creates the store and asks for the projection it held up', async () => {
    const { env, made } = lazyStores();
    const owner = { cookie: await signup('fresh') };
    const { body } = await api('/repos', owner, { body: seed('fresh') }, env);
    const project = await deliver(env, 'platform_project');
    expect(project[0].ack).toHaveBeenCalled();
    expect(project[0].retry).not.toHaveBeenCalled();
    expect(pushes).toEqual([]);
    const [job] = await deliver(env, STORE_JOB);
    expect(job.ack).toHaveBeenCalled();
    expect([...made]).toEqual([`yr-${body.id}`]);
    await deliver(env, 'platform_project');
    expect(pushes.some((p) => p.endsWith('refs/heads/main'))).toBe(true);
    const status = await api(`/repos/${body.id}`, owner, {}, env);
    expect(status.status).toBe(200);
  });

  it('takes a store that already exists as done, on a repeat or a late landing', async () => {
    const { env, create, made } = lazyStores();
    const owner = { cookie: await signup('twice') };
    await api('/repos', owner, { body: empty('twice') }, env);
    queued.push(...queued.filter((m) => m.kind === STORE_JOB));
    const jobs = await deliver(env, STORE_JOB);
    expect(jobs.map((j) => j.ack.mock.calls.length)).toEqual([1, 1]);
    expect(create).toHaveBeenCalledTimes(2);
    expect(made.size).toBe(1);
    expect(delayed).toEqual([]);
  });

  it('comes back as a fresh delayed message while Artifacts fails, never into the dead letters', async () => {
    let down = true;
    const { env, made } = lazyStores(async () => {
      if (down) throw coded('INTERNAL_ERROR');
    });
    const owner = { cookie: await signup('flaky') };
    await api('/repos', owner, { body: empty('flaky') }, env);
    const [job] = await deliver(env, STORE_JOB);
    expect(job.ack).toHaveBeenCalled();
    expect(job.retry).not.toHaveBeenCalled();
    expect(delayed.map((m) => [m.kind, m.attempt])).toEqual([[STORE_JOB, 1]]);
    down = false;
    queued.push(...delayed.splice(0));
    await deliver(env, STORE_JOB);
    expect(made.size).toBe(1);
    expect(delayed).toEqual([]);
  });

  describe('with Artifacts stalled', () => {
    beforeEach(() => void vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] }));
    afterEach(() => void vi.useRealTimers());

    it('gives up the attempt at its bound and comes back', async () => {
      const { env, create } = lazyStores(stalled);
      const owner = { cookie: await signup('stuck') };
      await api('/repos', owner, { body: empty('stuck') }, env);
      const settled = deliver(env, STORE_JOB);
      await vi.waitFor(() => expect(create).toHaveBeenCalled());
      await vi.advanceTimersByTimeAsync(STORE_JOB_ATTEMPT_MS);
      const [job] = await settled;
      expect(job.ack).toHaveBeenCalled();
      expect(delayed.map((m) => m.attempt)).toEqual([1]);
    });
  });

  it('leaves a deleted repository alone, and its restore asks for the store again', async () => {
    const { env, create, made } = lazyStores();
    const undo = { ...env, REPO_UNDO_DAYS: '30' } as unknown as Env;
    const owner = { cookie: await signup('undone') };
    const { body } = await api('/repos', owner, { body: seed('undone') }, undo);
    const deleted = await api(`/repos/${body.id}?confirm=undone`, owner, { method: 'DELETE' }, undo);
    expect(deleted.status, JSON.stringify(deleted.body)).toBe(200);
    const [job] = await deliver(undo, STORE_JOB);
    expect(job.ack).toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
    const restored = await api(`/repos/${body.id}/restore`, owner, { body: {} }, undo);
    expect(restored.status, JSON.stringify(restored.body)).toBe(200);
    await deliver(undo, STORE_JOB);
    expect([...made]).toEqual([`yr-${body.id}`]);
  });
});

describe('a repository whose store is not there yet', () => {
  it.each(['NOT_FOUND', 'CREATE_IN_PROGRESS'])('clones at once over Git (store: %s)', async (absent) => {
    const { env } = lazyStores(stalled, absent);
    const owner = { cookie: await signup('cloned') };
    const { body } = await api('/repos', owner, { body: seed('cloned') }, env);
    expect(await clone(env, body.id, body.tokens[0].token, body.commit)).toBeGreaterThanOrEqual(3);
  });

  it.each(['NOT_FOUND', 'CREATE_IN_PROGRESS'])('reads nothing from it rather than failing (store: %s)', async (absent) => {
    const { env } = lazyStores(stalled, absent);
    const store = parseStore(env, `artifacts:${env.ARTIFACTS_NAMESPACE}/yr-absent`);
    expect(await store.readCommit('0'.repeat(40))).toBeNull();
  });

  it('takes commits and pushes through the store of record', async () => {
    const { env, create } = lazyStores(stalled);
    const owner = { cookie: await signup('commits') };
    const { body } = await api('/repos', owner, { body: seed('commits') }, env);
    const next = await api(`/repos/${body.id}/commits`, owner, { body: { parent: body.commit, base_version: body.version, changes: [file('a.txt', 'a\n')], message: 'A file', author } }, env);
    expect(next.status, JSON.stringify(next.body)).toBe(200);
    expect(create).not.toHaveBeenCalled();
  });

  it('gives a mirror clone the store once the job made it', async () => {
    const { env } = lazyStores();
    const owner = { cookie: await signup('direct') };
    const { body } = await api('/repos', owner, { body: empty('direct') }, env);
    const asked = api(`/repos/${body.id}/clone`, owner, { method: 'POST' }, env);
    await deliver(env, STORE_JOB);
    const access = await asked;
    expect(access.status, JSON.stringify(access.body)).toBe(200);
    expect(access.body.remote).toContain(`yr-${body.id}`);
  });

  it('holds a commit too large to stage until the store exists', async () => {
    const { env } = lazyStores();
    const owner = { cookie: await signup('large') };
    const big = file('big.txt', 'x'.repeat(1_200_000));
    const asked = api('/repos', owner, { body: { ...seed('large'), files: [big] } }, env);
    await vi.waitFor(() => expect(storeJobs()).toHaveLength(1), { timeout: 5_000 });
    await deliver(env, STORE_JOB);
    const created = await asked;
    expect(created.status, JSON.stringify(created.body)).toBe(200);
  });

  it('forks with an empty store of its own: nothing is projected to copy', async () => {
    const { env, forked, made } = lazyStores();
    const owner = { cookie: await signup('parent') };
    const { body } = await api('/repos', owner, { body: seed('parent') }, env);
    const fork = await api(`/repos/${body.id}/fork`, owner, { body: { name: 'mine' } }, env);
    expect(fork.status, JSON.stringify(fork.body)).toBe(200);
    expect(forked).toEqual([]);
    expect(storeJobs()).toEqual([body.id, fork.body.id]);
    await deliver(env, STORE_JOB);
    expect(made).toEqual(new Set([`yr-${body.id}`, `yr-${fork.body.id}`]));
  });

  describe('past what a request waits', () => {
    beforeEach(() => void vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] }));
    afterEach(() => void vi.useRealTimers());

    it('answers a mirror clone with a retryable 503', async () => {
      const { env, get } = lazyStores();
      const owner = { cookie: await signup('waiting') };
      const { body } = await api('/repos', owner, { body: empty('waiting') }, env);
      const asked = api(`/repos/${body.id}/clone`, owner, { method: 'POST' }, env);
      await vi.waitFor(() => expect(get).toHaveBeenCalled());
      await vi.advanceTimersByTimeAsync(STORE_WAIT_MS);
      const refused = await asked;
      expect(refused.status).toBe(503);
      expect(refused.body.error.code).toBe('OVERLOADED');
      expect(refused.headers.get('retry-after')).toBe('1');
    });
  });
});

describe('with the switch off', () => {
  it('creates the store in the request and queues no job', async () => {
    const { env, create, made } = lazyStores();
    const off = { ...env, ASYNC_STORE: undefined } as unknown as Env;
    const owner = { cookie: await signup('switched') };
    const created = await api('/repos', owner, { body: empty('switched') }, off);
    expect(created.status, JSON.stringify(created.body)).toBe(200);
    expect(create).toHaveBeenCalledTimes(1);
    expect(made.size).toBe(1);
    expect(storeJobs()).toEqual([]);
    expect(phases(created.headers)).toContain('create.store');
  });
});
