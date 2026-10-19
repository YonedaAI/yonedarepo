// Source platform end to end in workerd: real SourceRepository DO SQLite and R2, with
// Artifacts faked at its binding and receive-pack endpoint. Scripted clients only —
// an "agent" here is just a repository token; no runs, harnesses or providers.
import { env } from 'cloudflare:workers';
import { reset } from 'cloudflare:test';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { fetchRequest } from '../../cloudflare/worker/routes';
import type { Env } from '../../cloudflare/worker/types';

const bindings = env as unknown as Env;
afterEach(() => {
  vi.restoreAllMocks();
  return reset();
});

const misses: string[] = [];
const fakeArtifacts = {
  create: async (name: string) => ({ name }),
  get: async (name: string) => ({
    [Symbol.dispose]() {},
    info: async () => ({ remote: `https://artifacts.test/${name}` }),
    createToken: async () => ({ id: 'token-1', plaintext: 'artifact-write-token' }),
    revokeToken: async () => true,
    // Stands in for "the store holds what was pushed": the pushed commit's cache copy.
    readCommit: async (id: string) => {
      const object = await bindings.OBJECTS.get(`platform/v1/${name.slice(3)}/objects/${id}`);
      if (!object) return null;
      const commit = await object.json<{ tree: string; parents: string[] }>();
      return { hash: id, treeHash: commit.tree, parents: commit.parents };
    },
    readTree: async (id: string) => {
      misses.push(`tree:${id}`);
      return null;
    },
    readBlob: async (id: string) => {
      misses.push(`blob:${id}`);
      return null;
    },
  }),
};
const scoped = { ...bindings, ARTIFACTS: fakeArtifacts } as unknown as Env;

beforeEach(() => {
  misses.length = 0;
  const original = globalThis.fetch;
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = String(input instanceof Request ? input.url : input);
    if (!url.startsWith('https://artifacts.test/')) return original(input, init);
    expect(url).toMatch(/\/git-receive-pack$/);
    const body = new Uint8Array(init?.body as ArrayBuffer);
    const command = new TextDecoder().decode(body.subarray(4, body.indexOf(0)));
    const ref = command.split(' ')[2];
    const ok = `ok ${ref}\n`;
    const report = `000eunpack ok\n${(ok.length + 4).toString(16).padStart(4, '0')}${ok}0000`;
    return new Response(report, { headers: { 'content-type': 'application/x-git-receive-pack-result' } });
  });
});

async function signup(username: string) {
  const response = await bindings.SELF.fetch('https://yoneda/api/auth/signup', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password: 'long platform test password' }),
  });
  expect(response.status).toBe(200);
  return (response.headers.get('set-cookie') ?? '').split(';')[0];
}

async function api(path: string, auth: { cookie?: string; token?: string }, init: { method?: string; body?: unknown } = {}) {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (auth.cookie) headers.cookie = auth.cookie;
  if (auth.token) headers.authorization = `Bearer ${auth.token}`;
  const response = await fetchRequest(
    new Request(`https://yoneda/api/v1${path}`, {
      method: init.method ?? (init.body ? 'POST' : 'GET'),
      headers,
      body: init.body ? JSON.stringify(init.body) : undefined,
    }),
    scoped,
  );
  return { status: response.status, body: await response.json<any>() };
}

const file = (path: string, text: string) => ({ path, content_b64: btoa(text) });
const author = { name: 'Scripted Client', email: 'client@example.com' };

it('commits, checks, reviews, lands and time-travels through the public API', async () => {
  const owner = { cookie: await signup('alice') };
  const created = await api('/repos', owner, {
    body: {
      policy: { required_checks: ['unit'], approvals: 1 },
      files: [file('README.md', '# demo\n'), file('src/lib.rs', 'pub fn a() {}\n')],
      author,
    },
  });
  expect(created.status).toBe(200);
  expect(created.body).toMatchObject({ version: 1 });
  const repo = `/repos/${created.body.id}`;

  const token = async (name: string, scopes: string[]) => {
    const result = await api(`${repo}/tokens`, owner, { body: { name, scopes } });
    expect(result.status).toBe(200);
    expect(result.body.token).toMatch(/^yrp_/);
    return { token: result.body.token as string };
  };
  const agent = await token('agent', ['read', 'write']);
  const ci = await token('ci', ['read', 'check']);

  const committed = await api(`${repo}/commits`, agent, {
    body: {
      ref: 'main',
      changes: [file('src/lib.rs', 'pub fn a() { 1 }\n'), file('docs/a.md', 'hello\n')],
      message: 'Update a and add docs',
      author,
      read_set: ['src/'],
    },
  });
  expect(committed.status).toBe(200);
  const sha = committed.body.commit as string;
  expect(committed.body.touches.map((t: any) => `${t.op}:${t.path}`)).toEqual(['modify:src/lib.rs', 'add:docs/a.md']);

  expect((await api(`${repo}/land`, agent, { body: { ref: 'main', commit: sha } })).status).toBe(403);
  expect((await api(`${repo}/land`, owner, { body: { ref: 'main', commit: sha } })).body.error.code).toBe('NOT_READY');
  expect((await api(`${repo}/commits/${sha}/reviews`, agent, { body: { decision: 'approve' } })).status).toBe(403);
  expect((await api(`${repo}/commits/${sha}/checks`, ci, { body: { name: 'unit', status: 'pass' } })).status).toBe(200);
  expect((await api(`${repo}/commits/${sha}/reviews`, owner, { body: { decision: 'approve' } })).status).toBe(200);
  const landed = await api(`${repo}/land`, owner, { body: { ref: 'main', commit: sha } });
  expect(landed.body).toMatchObject({ landed: true, version: 2 });

  const now = await api(`${repo}/blob?path=src/lib.rs`, agent);
  expect(now.body).toMatchObject({ commit: sha, encoding: 'utf-8', content: 'pub fn a() { 1 }\n' });
  const before = await api(`${repo}/blob?path=src/lib.rs&at=1`, agent);
  expect(before.body.content).toBe('pub fn a() {}\n');
  const root = await api(`${repo}/tree?path=`, agent);
  expect(root.body.entries.map((e: any) => e.name).sort()).toEqual(['README.md', 'docs', 'src']);
  const log = await api(`${repo}/log?ref=main`, agent);
  expect(log.body.commits.map((c: any) => c.commit)[0]).toBe(sha);
  const txlog = await api(`${repo}/txlog`, ci);
  expect(txlog.body.entries.map((e: any) => e.kind)).toEqual(['import', 'commit']);
  // Every object read was served by the R2 tier written through at commit time.
  expect(misses).toEqual([]);

  const stranger = { cookie: await signup('bob') };
  expect((await api(repo, stranger)).status).toBe(403);
  expect((await api(repo, {})).status).toBe(401);
  expect((await api(repo, { token: 'yrp_guessed-token-value-0123456789' })).status).toBe(401);
});

it('rejects a commit whose base moved underneath it on the same paths', async () => {
  const owner = { cookie: await signup('carol') };
  const created = await api('/repos', owner, {
    body: { policy: { required_checks: [], approvals: 0 }, files: [file('a.txt', 'a\n')], author },
  });
  const repo = `/repos/${created.body.id}`;
  const first = await api(`${repo}/commits`, owner, { body: { ref: 'main', changes: [file('a.txt', 'one\n')], message: 'one', author } });
  const second = await api(`${repo}/commits`, owner, { body: { ref: 'main', changes: [file('a.txt', 'two\n')], message: 'two', author } });
  expect((await api(`${repo}/land`, owner, { body: { ref: 'main', commit: first.body.commit } })).body.version).toBe(2);
  const conflict = await api(`${repo}/land`, owner, { body: { ref: 'main', commit: second.body.commit } });
  expect(conflict.status).toBe(409);
  expect(conflict.body.error.code).toBe('CONFLICT');
});
