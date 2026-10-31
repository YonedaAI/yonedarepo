// Creating a repository: every step of the request is accounted for in Server-Timing, also
// when one fails, so a slow or stalled create names the step responsible. A failed create
// leaves nothing in the way of repeating it, and says so with a retryable answer.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { withWaitUntil } from '../../cloudflare/worker/background';
import { STORE_ATTEMPT_MS } from '../../cloudflare/worker/repo-create';
import { SHARDS } from '../../cloudflare/worker/repo-shards';
import type { Env } from '../../cloudflare/worker/types';
import { api, author, fakeArtifacts, fakeQueue, file, queued, scoped, signup, usePlatformFixture } from './repo-fixture';

usePlatformFixture();

const seed = (name: string) => ({ name, policy: { required_checks: [], approvals: 0 }, files: [file('README.md', `# ${name}\n`)], author });
const phases = (headers: Headers) =>
  (headers.get('server-timing') ?? '').split(', ').map((entry) => entry.split(';')[0]);

it('accounts for every step of a seeded create in Server-Timing', async () => {
  const owner = { cookie: await signup('timed') };
  const created = await api('/repos', owner, { body: { ...seed('timed'), tokens: [{ name: 'ci', scopes: ['read'] }] } });
  expect(created.status, JSON.stringify(created.body)).toBe(200);
  expect(phases(created.headers)).toEqual(
    expect.arrayContaining([
      'create.owner',
      'create.name',
      'create.store',
      'do.repo_init',
      'create.shards',
      'shard.status',
      'create.list',
      'create.tokens',
      'create.commit',
      'do.repo_import',
      'create.project',
      'create.head',
    ]),
  );
});

it('names the step that failed in Server-Timing', async () => {
  const owner = { cookie: await signup('failing') };
  const down = { ...fakeArtifacts, create: async () => Promise.reject(new Error('internal error; reference = abc123')) };
  const env = { ...scoped, ARTIFACTS: down } as unknown as Env;
  const created = await api('/repos', owner, { body: seed('failing') }, env);
  expect(created.status).toBe(503);
  expect(phases(created.headers)).toEqual(expect.arrayContaining(['create.name', 'create.store']));
});

const artifactsWith = (create: (name: string) => Promise<unknown>) =>
  ({ ...scoped, ARTIFACTS: { ...fakeArtifacts, create } }) as unknown as Env;
const stalled = () => new Promise<never>(() => {});
const names = async (cookie: string) => (await api('/repos', { cookie })).body.repos.map((r: any) => r.name);
const purges = () => queued.filter((m) => m.kind === 'platform_purge').map((m) => m.repo_id);

/** Each attempt at the store waited out on fake timers; `attempts`: how many it sees. */
async function waitedOut<T>(pending: Promise<T>, attempts: () => number, count: number) {
  for (let attempt = 1; attempt <= count; attempt++) {
    await vi.waitFor(() => expect(attempts()).toBe(attempt));
    await vi.advanceTimersByTimeAsync(STORE_ATTEMPT_MS);
  }
  return pending;
}

describe('a stalled object store', () => {
  beforeEach(() => void vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] }));
  afterEach(() => void vi.useRealTimers());

  it('answers a retryable 503 after one retry, frees the name, and the same name then works', async () => {
    const owner = { cookie: await signup('stalled') };
    let attempts = 0;
    const env = artifactsWith(() => {
      attempts++;
      return stalled();
    });
    const refused = await waitedOut(api('/repos', owner, { body: seed('stalled') }, env), () => attempts, 2);
    expect(attempts).toBe(2);
    expect(refused.status).toBe(503);
    expect(refused.body.error.code).toBe('CREATE_UNAVAILABLE');
    expect(refused.headers.get('retry-after')).toBe('1');
    expect(await names(owner.cookie)).toEqual([]);
    vi.useRealTimers();
    const retried = await api('/repos', owner, { body: seed('stalled') });
    expect(retried.status, JSON.stringify(retried.body)).toBe(200);
    expect(await names(owner.cookie)).toEqual(['stalled']);
  });

  it('takes a store whose first attempt landed late as created', async () => {
    const owner = { cookie: await signup('late') };
    let attempts = 0;
    const env = artifactsWith(() => {
      attempts++;
      if (attempts === 1) return stalled();
      return Promise.reject(Object.assign(new Error('Repository exists'), { code: 'ALREADY_EXISTS' }));
    });
    const body = { name: 'late', policy: { required_checks: [], approvals: 0 } };
    const created = await waitedOut(api('/repos', owner, { body }, env), () => attempts, 1);
    expect(created.status, JSON.stringify(created.body)).toBe(200);
  });
});

describe('a create that fails after the store', () => {
  it('takes back all it did when the listing has the repository, so the same name works', async () => {
    const owner = { cookie: await signup('undone') };
    const down = { ...scoped, PLATFORM_QUEUE: { ...fakeQueue, send: async (message: any) => {
      if (message.kind === 'platform_project') throw new Error('internal error; reference = abc123');
      return fakeQueue.send(message);
    } } } as unknown as Env;
    const refused = await api('/repos', owner, { body: seed('undone') }, down);
    expect(refused.status).toBe(503);
    expect(refused.body.error.code).toBe('CREATE_UNAVAILABLE');
    expect(refused.body.error.message).not.toContain('reference');
    expect(await names(owner.cookie)).toEqual([]);
    expect(purges()).toHaveLength(1);
    expect((await api('/repos', owner, { body: seed('undone') })).status).toBe(200);
  });

  it("keeps the caller's own mistake as it was, and frees the name for the corrected request", async () => {
    const owner = { cookie: await signup('mistaken') };
    const refused = await api('/repos', owner, { body: { ...seed('mistaken'), files: [file('../escape', 'x')] } });
    expect(refused.status).toBe(400);
    expect(refused.body.error.code).toBe('UNSAFE_PATH');
    expect(await names(owner.cookie)).toEqual([]);
    expect((await api('/repos', owner, { body: seed('mistaken') })).status).toBe(200);
  });
});

describe('commit shards of a new repository', () => {
  const shardsAnswering = (fetch: () => Promise<Response>, extra = {}) =>
    ({ ...scoped, ...extra, COMMIT_SHARDS: { idFromName: (name: string) => name, get: () => ({ fetch }) } }) as unknown as Env;

  it('start after the answer, which never waits for them', async () => {
    const owner = { cookie: await signup('deferred') };
    const lent: Promise<unknown>[] = [];
    let release = () => {};
    const held = new Promise<void>((resolve) => void (release = resolve));
    let started = 0;
    const env = shardsAnswering(async () => {
      started++;
      await held;
      return Response.json({});
    });
    const created = await withWaitUntil((work) => void lent.push(work), () =>
      api('/repos', owner, { body: { name: 'deferred', policy: { required_checks: [], approvals: 0 } } }, env),
    );
    expect(created.status, JSON.stringify(created.body)).toBe(200);
    expect(phases(created.headers)).not.toContain('create.shards');
    expect(started).toBe(SHARDS);
    release();
    await Promise.all(lent);
  });

  it('wait in the request behind the switch, and a failure to start never fails the create', async () => {
    const owner = { cookie: await signup('waited') };
    const down = shardsAnswering(() => Promise.reject(new Error('internal error; reference = abc123')), { SHARD_START: 'request' });
    const created = await api('/repos', owner, { body: { name: 'waited', policy: { required_checks: [], approvals: 0 } } }, down);
    expect(created.status, JSON.stringify(created.body)).toBe(200);
    expect(phases(created.headers)).toContain('create.shards');
  });
});
