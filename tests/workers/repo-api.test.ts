// Source platform end to end in workerd through the public API (see repo-fixture.ts).
import { expect, it } from 'vitest';
import { platformFetch } from '../../cloudflare/worker/platform-routes';
import type { Env } from '../../cloudflare/worker/types';
import { api, author, bindings, executed, file, misses, queued, scoped, signup, usePlatformFixture } from './repo-fixture';

usePlatformFixture();

it('commits, checks, reviews, lands and time-travels through the public API', async () => {
  const owner = { cookie: await signup('alice') };
  const created = await api('/repos', owner, {
    body: {
      name: 'demo-app',
      policy: { required_checks: ['unit'], approvals: 1, check_posters: { unit: ['token:ci'] } },
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
  // A required check is posted only by its bound posters: not the writer, not even the owner.
  for (const caller of [agent, owner])
    expect((await api(`${repo}/commits/${sha}/checks`, caller, { body: { name: 'unit', status: 'pass' } })).status).toBe(403);
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

  const listed = await api('/repos', owner);
  expect(listed.body.repos.map((r: any) => [r.id, r.name])).toEqual([[created.body.id, 'demo-app']]);
  expect((await api(repo, owner)).body.name).toBe('demo-app');
  expect((await api('/repos', agent)).status).toBe(403);

  const stranger = { cookie: await signup('bob') };
  expect((await api(repo, stranger)).status).toBe(404);
  expect((await api('/repos', stranger)).body.repos).toEqual([]);
  // Without credentials a private repository is not found; writes ask for credentials.
  expect((await api(repo, {})).status).toBe(404);
  expect((await api(`${repo}/commits`, {}, { body: {} })).status).toBe(401);
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
  const response = await platformFetch(
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
  const runs = () => queued.filter((m) => m.kind === 'platform_check');
  expect(runs()).toHaveLength(2);
  expect(good.body.check_runs[0]).toMatchObject({ name: 'unit', status: 'queued' });
  for (const envelope of runs()) expect(await executeCheckRun(scoped, envelope)).toBeUndefined();
  // Each run shipped its own commit's bytes to a container instance named per attempt.
  expect(executed.map((e) => e.name)).toEqual([`${runs()[0].job_id}:1`, `${runs()[1].job_id}:1`]);
  expect(executed[1].job.command).toEqual(['sh', '-c', 'test']);

  const failed = await api(`${repo}/commits/${bad.body.commit}`, bot);
  expect(failed.body.gates.failing_checks).toEqual(['unit']);
  expect(failed.body.checks[0]).toMatchObject({ status: 'fail', principal: 'platform:checks' });
  expect((await api(`${repo}/land`, bot, { body: { ref: 'main', commit: bad.body.commit } })).body.error.code).toBe('NOT_READY');
  const log = await api(`/repos/${created.body.id}/check-runs/${runs()[0].job_id}/log`, bot);
  expect(log.body.log).toBe('bad\n');
  expect((await api(`${repo}/land`, bot, { body: { ref: 'main', commit: good.body.commit } })).body.landed).toBe(true);

  // A redelivered message for a finished run is a no-op.
  expect(await executeCheckRun(scoped, runs()[1])).toBeUndefined();
  expect(executed).toHaveLength(2);
  // Re-requesting a finished check returns the existing run instead of queueing another.
  const again = await api(`${repo}/commits/${good.body.commit}/check-runs`, bot, { body: {} });
  expect(again.body.runs[0].existing).toBe(true);
  expect(runs()).toHaveLength(2);
});

it('runs the whole platform on the R2 object store with Rust-verified pushes', async () => {
  const local = { ...scoped, PLATFORM_OBJECT_STORE: 'r2', ARTIFACTS: undefined } as unknown as Env;
  const call = async (path: string, auth: { cookie?: string }, body?: unknown) => {
    const headers: Record<string, string> = { 'content-type': 'application/json', cookie: auth.cookie ?? '' };
    const response = await platformFetch(
      new Request(`https://yoneda/api/v1${path}`, { method: body ? 'POST' : 'GET', headers, body: body ? JSON.stringify(body) : undefined }),
      local,
    );
    return { status: response.status, body: await response.json<any>() };
  };
  const owner = { cookie: await signup('frank') };
  const created = await call('/repos', owner, { name: 'local', policy: { required_checks: [], approvals: 0 }, files: [file('a.txt', 'one\n')], author });
  expect(created.status).toBe(200);
  const repo = `/repos/${created.body.id}`;
  expect((await call(repo, owner)).body.object_store).toBe(`r2:yr-${created.body.id}`);
  const next = await call(`${repo}/commits`, owner, { ref: 'main', changes: [file('b/c.txt', 'two\n')], message: 'two', author });
  expect(next.status).toBe(200);
  expect((await call(`${repo}/land`, owner, { ref: 'main', commit: next.body.commit })).body.landed).toBe(true);
  // Cold reads bypass the cache tier and come from the R2 store's own objects.
  for (const key of (await bindings.OBJECTS.list({ prefix: `platform/v1/${created.body.id}/` })).objects)
    await bindings.OBJECTS.delete(key.key);
  expect((await call(`${repo}/blob?path=b/c.txt`, owner)).body.content).toBe('two\n');
  expect((await call(`${repo}/diff?patch=1`, owner)).body.changes[0].patch).toBe('@@ -0,0 +1 @@\n+two\n');
});
