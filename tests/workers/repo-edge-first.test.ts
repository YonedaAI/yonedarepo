// Real workerd Cache API/R2/SQLite; local runtime proves ordering, not geographic latency.
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { expect, it, vi } from 'vitest';
import { platformFetch } from '../../cloudflare/worker/platform-routes';
import { edgeDelete, edgePut } from '../../cloudflare/worker/repo-cache-tiers';
import { fenceReadCopies } from '../../cloudflare/worker/repo-locality';
import { RepoObjects, gitObjectId, parseStore } from '../../cloudflare/worker/repo-objects';
import { withTimings } from '../../cloudflare/worker/repo-timing';
import { inScope } from '../../cloudflare/worker/request-scope';
import type { Env } from '../../cloudflare/worker/types';
import { api, author, bindings, drainObjects, file, scoped, signup, usePlatformFixture } from './repo-fixture';

usePlatformFixture();
const on = { ...scoped, AUTOMATIC_LOCALITY: 'on', EDGE_FIRST_READS: 'on' } as Env;
const repo = 'rabcdef0123456789abcd';
const CONTENT = 'A cached immutable object\n';
const blob = await gitObjectId('blob', new TextEncoder().encode(CONTENT));
const scope = (env: Env, waitUntil?: (p: Promise<unknown>) => void) => ({
  env, waitUntil, req: new Request('https://yoneda/api/v1/', { cf: { continent: 'EU' } }),
});
const objects = (env: Env) => new RepoObjects(env, repo, parseStore(env, `platform:${repo}`)).withhold([]);

it('answers an edge hit before a held regional permit/fill and performs no regional get', async () => {
  await edgePut(repo, blob, 'blob', CONTENT);
  const ns = bindings.READ_COPIES!;
  let release!: () => void;
  const held = new Promise<void>((done) => { release = done; });
  const ops: string[] = [];
  const watched = { idFromName: (name: string) => ns.idFromName(name), get: (id: DurableObjectId, options?: DurableObjectNamespaceGetDurableObjectOptions) => {
    const stub = ns.get(id, options);
    return { fetch: async (url: string, init: RequestInit) => {
      const op = JSON.parse(String(init.body)).op; ops.push(op);
      if (op === 'registry_permit') await held;
      return stub.fetch(url, init);
    } };
  } } as unknown as DurableObjectNamespace;
  const env = { ...on, READ_COPIES: watched };
  const background: Promise<unknown>[] = [];
  const ctx = createExecutionContext();
  const controller = new AbortController();
  const requestScope = { ...scope(env, (p) => { background.push(p); ctx.waitUntil(p); }), req: new Request('https://yoneda/api/v1/', { cf: { continent: 'EU' }, signal: controller.signal }) };
  const reading = inScope(requestScope, () => objects(env).blob(blob));
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const first = await Promise.race([reading.then(() => 'answered'), new Promise<string>((done) => { timer = setTimeout(() => done('blocked'), 100); })]);
    expect(first).toBe('answered');
    expect(new TextDecoder().decode(await reading)).toBe(CONTENT);
    expect(ops).not.toContain('copy_get');
    expect(background.length).toBeGreaterThan(0);
    controller.abort();
    // A separate request must not join the first one's held I/O after it disconnects.
    const later = await inScope(scope(env, (p) => { background.push(p); ctx.waitUntil(p); }), () => objects(env).blob(blob));
    expect(new TextDecoder().decode(later)).toBe(CONTENT);
  } finally {
    clearTimeout(timer); release(); await reading; await waitOnExecutionContext(ctx); await Promise.all(background);
  }
});

it('retains nearby before R2 on an edge miss and reports actual copy hits separately', async () => {
  const warm = objects(on);
  await edgePut(repo, blob, 'blob', CONTENT);
  await inScope(scope(on), () => warm.blob(blob));
  await edgeDelete(repo, blob);
  const { value, phases } = await inScope(scope(on), () => withTimings(() => objects(on).blob(blob)));
  expect(new TextDecoder().decode(value)).toBe(CONTENT);
  expect(phases.get('read.copy.permit')?.n).toBe(1);
  expect(phases.get('read.copy.get')?.n).toBe(1);
  expect(phases.get('read.copy.hit')?.n).toBe(1);
  expect(phases.has('read.r2')).toBe(false);
});

it('keeps the switch-off traversal and awaited fill lifetime', async () => {
  await edgePut(repo, blob, 'blob', CONTENT);
  const env = { ...on, EDGE_FIRST_READS: 'off' };
  const { phases } = await inScope(scope(env), () => withTimings(() => objects(env).blob(blob)));
  expect(phases.get('read.copy.get')?.n).toBeGreaterThan(0);
  expect(phases.get('read.copy.miss')?.n).toBe(1);
  // Without waitUntil the fill is complete before the caller regains control.
  await edgeDelete(repo, blob);
  const { phases: later } = await inScope(scope(env), () => withTimings(() => objects(env).blob(blob)));
  expect(later.get('read.copy.hit')?.n).toBe(1);
});

it('a wrong edge kind falls through a real copy miss to R2 exactly once', async () => {
  await edgePut(repo, blob, 'tree', 'not a blob');
  const reader = objects(on);
  await bindings.OBJECTS.put(reader.key(blob), CONTENT, { customMetadata: { kind: 'blob' } });
  const { value, phases } = await inScope(scope(on), () => withTimings(() => reader.blob(blob)));
  expect(new TextDecoder().decode(value)).toBe(CONTENT);
  expect(phases.get('read.edge')?.n).toBe(1);
  expect(phases.get('read.copy.miss')?.n).toBe(1);
  expect(phases.get('read.r2')?.n).toBe(1);
});

it('quarantine refuses warm bytes before asking any tier', async () => {
  await edgePut(repo, blob, 'blob', CONTENT);
  const { phases } = await inScope(scope(on), () => withTimings(async () => {
    await expect(objects(on).withhold([{ id: blob, path: 'a.txt' }]).blob(blob)).rejects.toMatchObject({ code: 'QUARANTINED' });
  }));
  expect(phases.has('read.edge')).toBe(false);
  expect(phases.has('read.nearby')).toBe(false);
});

async function created(name: string) {
  const cookie = await signup(name);
  const made = await api('/repos', { cookie }, { body: { name, files: [file('public/a.txt', CONTENT), file('secret.txt', 'hidden\n')], author, policy: { approvals: 0, required_checks: [] } } }, on);
  expect(made.status).toBe(200);
  await drainObjects(on);
  return { id: made.body.id as string, cookie };
}
const readFile = async (id: string, headers: HeadersInit, path = 'public/a.txt') => {
  const response = await platformFetch(new Request(`https://yoneda/api/v1/repos/${id}/blob?path=${path}`, { headers, cf: { continent: 'EU' } }), on);
  return { status: response.status, body: await response.json<any>() };
};

it('private edge hits still enforce fresh membership, path grants and token revocation', async () => {
  const r = await created('edge_first_access');
  expect((await readFile(r.id, { cookie: r.cookie })).body.content).toBe(CONTENT);
  const stranger = await signup('edge_first_stranger');
  expect((await readFile(r.id, { cookie: stranger })).status).toBe(404);
  expect((await readFile(r.id, {})).status).toBe(404);
  const token = await api(`/repos/${r.id}/tokens`, { cookie: r.cookie }, { body: { name: 'reader', scopes: ['read'], paths: ['public/'] } }, on);
  expect(token.status).toBe(200);
  const headers = { authorization: `Bearer ${token.body.token}` };
  expect((await readFile(r.id, headers)).body.content).toBe(CONTENT);
  expect((await readFile(r.id, headers, 'secret.txt')).status).toBe(403);
  expect((await api(`/repos/${r.id}/tokens/reader`, { cookie: r.cookie }, { method: 'DELETE' }, on)).status).toBe(200);
  expect((await readFile(r.id, headers)).status).toBe(401);
  const quarantine = await api(`/repos/${r.id}/quarantine`, { cookie: r.cookie }, { body: { kind: 'blob', path: 'public/a.txt', reason: 'simulated fixture', retain_days: 30 } }, on);
  expect(quarantine.status).toBe(200);
  expect((await readFile(r.id, { cookie: r.cookie })).status).toBe(451);
});

it('warm inherited edge bytes keep the parent guard and reachable fork reads', async () => {
  const r = await created('edge_first_parent');
  const cookie = await signup('edge_first_forker');
  expect((await api(`/repos/${r.id}/members`, { cookie: r.cookie }, { body: { account: 'edge_first_forker', role: 'read' } }, on)).status).toBe(200);
  expect((await readFile(r.id, { cookie: r.cookie })).status).toBe(200);
  const fork = await api(`/repos/${r.id}/fork`, { cookie }, { body: {} }, on);
  expect(fork.status).toBe(200);
  const made = await api(`/repos/${fork.body.id}/tokens`, { cookie }, { body: { name: 'fork', scopes: ['read'] } }, on);
  const token = { token: made.body.token };
  expect((await api(`/repos/${fork.body.id}/objects`, token, { body: { objects: [{ id: blob, kind: 'blob' }] } }, on)).status).toBe(403);
  expect((await readFile(fork.body.id, { authorization: `Bearer ${made.body.token}` })).body.content).toBe(CONTENT);
});

it('a held local probe is bounded and falls back without a second edge lookup', async () => {
  const env = { ...on, AUTOMATIC_LOCALITY: 'off' };
  const reader = objects(env);
  await bindings.OBJECTS.put(reader.key(blob), CONTENT, { customMetadata: { kind: 'blob' } });
  let release!: () => void;
  const gate = new Promise<void>((done) => { release = done; });
  const actual = caches.default.match.bind(caches.default);
  const lookup = vi.spyOn(caches.default, 'match').mockImplementation(async (...args) => { await gate; return actual(...args); });
  const reading = inScope(scope(env), () => reader.blob(blob));
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    expect(await Promise.race([reading.then(() => 'answered'), new Promise<string>((done) => { timer = setTimeout(() => done('blocked'), 1000); })])).toBe('answered');
    expect(new TextDecoder().decode(await reading)).toBe(CONTENT);
    expect(lookup).toHaveBeenCalledTimes(1);
  } finally { clearTimeout(timer); release(); await reading; lookup.mockRestore(); }
});

it('a deferred edge-hit fill cannot republish after a newer quarantine fence', async () => {
  await edgePut(repo, blob, 'blob', CONTENT);
  const ns = bindings.READ_COPIES!;
  let release!: () => void; let reached!: () => void;
  const held = new Promise<void>((done) => { release = done; });
  const entered = new Promise<void>((done) => { reached = done; });
  const watched = { idFromName: (name: string) => ns.idFromName(name), get: (id: DurableObjectId, options?: DurableObjectNamespaceGetDurableObjectOptions) => {
    const stub = ns.get(id, options);
    return { fetch: async (url: string, init: RequestInit) => {
      if (JSON.parse(String(init.body)).op === 'copy_put') { reached(); await held; }
      return stub.fetch(url, init);
    } };
  } } as unknown as DurableObjectNamespace;
  const env = { ...on, READ_COPIES: watched };
  const ctx = createExecutionContext();
  expect(new TextDecoder().decode(await inScope(scope(env, (p) => ctx.waitUntil(p)), () => objects(env).blob(blob)))).toBe(CONTENT);
  await entered;
  try { await fenceReadCopies(on, repo, [blob]); } finally { release(); await waitOnExecutionContext(ctx); }
  const command = async (region: string, body: object) => (await ns.get(ns.idFromName(`${repo}:read:${region}`)).fetch('https://read-copy/', { method: 'POST', body: JSON.stringify({ ...body, repo, ...(region !== 'registry' && { region }), _system: 'local-copy' }) })).json<any>();
  const permit = await command('registry', { op: 'registry_permit', region: 'weur' });
  expect(permit.blocked).toContain(blob);
  expect((await command('weur', { op: 'copy_get', epoch: permit.epoch, id: blob, kind: 'blob' })).object).toBeNull();
});
