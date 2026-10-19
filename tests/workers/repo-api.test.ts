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
// Platform jobs and check containers: the queue records messages; the executor stands in
// for the Container by evaluating the shipped files (the real one is tested in Rust).
const queued: any[] = [];
const executed: any[] = [];
const fakeQueue = { sendBatch: async (messages: { body: any }[]) => void queued.push(...messages.map((m) => m.body)) };
const fakeRunners = {
  idFromName: (name: string) => name,
  get: (name: string) => ({
    run: async (job: any) => {
      executed.push({ name, job });
      const file = job.files.find((f: any) => f.path === 'a.txt');
      const ok = file && atob(file.data_b64).startsWith('good');
      return { outcome: ok ? 'pass' : 'fail', exit_code: ok ? 0 : 1, timed_out: false, duration_ms: 5,
        output_bytes: 4, output_sha256: 'f'.repeat(64), output_tail: ok ? 'ok\n' : 'bad\n' };
    },
  }),
};
const scoped = { ...bindings, ARTIFACTS: fakeArtifacts, PLATFORM_QUEUE: fakeQueue, CHECK_RUNNERS: fakeRunners } as unknown as Env;

beforeEach(() => {
  misses.length = 0;
  queued.length = 0;
  executed.length = 0;
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
  const changed = await api(`${repo}/diff?head=${sha}&patch=1`, agent);
  expect(changed.body.changes.map((c: any) => `${c.op}:${c.path}`)).toEqual(['add:docs/a.md', 'modify:src/lib.rs']);
  expect(changed.body.changes[1]).toMatchObject({
    patch: '@@ -1 +1 @@\n-pub fn a() {}\n+pub fn a() { 1 }\n',
    additions: 1,
    deletions: 1,
  });
  const scoped = await api(`${repo}/diff?base=main&head=${sha}&path=docs`, agent);
  expect(scoped.body.changes).toEqual([]);
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

async function mcp(repo: string, auth: { token?: string }, method: string, params?: unknown, id: number | null = 1) {
  const headers: Record<string, string> = { 'content-type': 'application/json', 'MCP-Protocol-Version': '2025-06-18' };
  if (auth.token) headers.authorization = `Bearer ${auth.token}`;
  const response = await fetchRequest(
    new Request(`https://yoneda/api/v1/repos/${repo}/mcp`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ jsonrpc: '2.0', ...(id === null ? {} : { id }), method, params }),
    }),
    scoped,
  );
  return { status: response.status, body: response.status === 202 ? null : await response.json<any>() };
}

it('serves the same operations over MCP with Git-verb tools', async () => {
  const owner = { cookie: await signup('dana') };
  const created = await api('/repos', owner, {
    body: { policy: { required_checks: [], approvals: 1 }, files: [file('a.txt', 'a\n')], author },
  });
  const id = created.body.id as string;
  const minted = await api(`/repos/${id}/tokens`, owner, { body: { name: 'mcp', scopes: ['read', 'write'] } });
  const agent = { token: minted.body.token as string };

  const init = await mcp(id, agent, 'initialize', { protocolVersion: '2025-06-18' });
  expect(init.body.result.serverInfo.name).toBe('yonedarepo-source');
  expect((await mcp(id, agent, 'notifications/initialized', undefined, null)).status).toBe(202);
  const { operations } = await import('../../cloudflare/worker/repo-tools');
  const listed = await mcp(id, agent, 'tools/list');
  expect(listed.body.result.tools.map((t: any) => t.name).sort()).toEqual(Object.keys(operations).sort());

  const made = await mcp(id, agent, 'tools/call', {
    name: 'git_commit',
    arguments: { ref: 'main', changes: [file('a.txt', 'b\n')], message: 'edit a', author },
  });
  const sha = made.body.result.structuredContent.commit;
  expect(sha).toMatch(/^[0-9a-f]{40}$/);
  const diffed = await mcp(id, agent, 'tools/call', { name: 'git_diff', arguments: { head: sha, patch: true } });
  expect(diffed.body.result.structuredContent.changes[0].patch).toBe('@@ -1 +1 @@\n-a\n+b\n');
  const read = await mcp(id, agent, 'tools/call', { name: 'git_cat_file', arguments: { path: 'a.txt', commit: sha } });
  expect(read.body.result.structuredContent.content).toBe('b\n');

  const landing = await mcp(id, agent, 'tools/call', { name: 'git_land', arguments: { ref: 'main', commit: sha } });
  expect(landing.body.result.isError).toBe(true);
  expect(landing.body.result.content[0].text).toMatch(/^FORBIDDEN/);
  const unknown = await mcp(id, agent, 'tools/call', { name: 'constructor', arguments: {} });
  expect(unknown.body.result.isError).toBe(true);
  expect((await mcp(id, {}, 'tools/list')).status).toBe(401);
});

it('runs policy checks on the exact commit and gates landing on them', async () => {
  const { executeCheckRun } = await import('../../cloudflare/worker/repo-checks');
  const owner = { cookie: await signup('erin') };
  const created = await api('/repos', owner, {
    body: { policy: { required_checks: [], approvals: 0 }, files: [file('a.txt', 'good\n')], author },
  });
  const repo = `/repos/${created.body.id}`;
  const policy = { required_checks: ['unit'], approvals: 0, runners: { unit: { command: ['sh', '-c', 'test'], timeout_seconds: 30 } } };
  const minted = await api(`${repo}/tokens`, owner, { body: { name: 'bot', scopes: ['read', 'write', 'land'] } });
  const bot = { token: minted.body.token as string };
  expect((await api(`${repo}/policy`, bot, { method: 'PUT', body: { policy } })).status).toBe(403);
  expect((await api(`${repo}/policy`, owner, { method: 'PUT', body: { policy } })).status).toBe(200);

  const bad = await api(`${repo}/commits`, bot, { body: { ref: 'main', changes: [file('a.txt', 'bad\n')], message: 'bad', author } });
  const good = await api(`${repo}/commits`, bot, { body: { ref: 'main', changes: [file('a.txt', 'good v2\n')], message: 'good', author } });
  expect(queued.map((m) => m.kind)).toEqual(['platform_check', 'platform_check']);
  expect(good.body.check_runs[0]).toMatchObject({ name: 'unit', status: 'queued' });
  for (const envelope of [...queued]) expect(await executeCheckRun(scoped, envelope)).toEqual({});
  // Each run shipped its own commit's bytes to a container instance named per attempt.
  expect(executed.map((e) => e.name)).toEqual([`${queued[0].job_id}:1`, `${queued[1].job_id}:1`]);
  expect(executed[1].job.command).toEqual(['sh', '-c', 'test']);

  const failed = await api(`${repo}/commits/${bad.body.commit}`, bot);
  expect(failed.body.gates.failing_checks).toEqual(['unit']);
  expect(failed.body.checks[0]).toMatchObject({ status: 'fail', principal: 'platform:checks' });
  expect((await api(`${repo}/land`, bot, { body: { ref: 'main', commit: bad.body.commit } })).body.error.code).toBe('NOT_READY');
  const log = await api(`/repos/${created.body.id}/check-runs/${queued[0].job_id}/log`, bot);
  expect(log.body.log).toBe('bad\n');
  expect((await api(`${repo}/land`, bot, { body: { ref: 'main', commit: good.body.commit } })).body.landed).toBe(true);

  // A redelivered message for a finished run is a no-op.
  expect(await executeCheckRun(scoped, queued[1])).toEqual({});
  expect(executed).toHaveLength(2);
  // Re-requesting a finished check returns the existing run instead of queueing another.
  const again = await api(`${repo}/commits/${good.body.commit}/check-runs`, bot, { body: {} });
  expect(again.body.runs[0].existing).toBe(true);
  expect(queued).toHaveLength(2);
});
