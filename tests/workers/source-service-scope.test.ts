import { reset, runInDurableObject } from 'cloudflare:test';
import { afterEach, expect, it, vi } from 'vitest';
import { sourceBroker } from '../../cloudflare/worker/source-broker';
import { hex, sourceFingerprint, sourceMac } from '../../cloudflare/worker/source-crypto';
import { ensureSourceIndex, sourceIndexBounded } from '../../cloudflare/worker/source-index';
import { sourceScope } from '../../cloudflare/worker/source-scope';
import { ledger } from '../../cloudflare/worker/storage';
import type { Env, Json, Scope } from '../../cloudflare/worker/types';
import { bindings, sourceFixture } from '../../tools/source-benchmark/workerd-source-fixture';
import { reviewerPolicy } from '../../cloudflare/worker/reviewer-policy';

afterEach(reset);
async function storedJob(repo: string, id: string) {
  const stub = bindings.REPOSITORIES.get(bindings.REPOSITORIES.idFromName(repo));
  return runInDurableObject(stub, (_instance, state) => JSON.parse(String(state.storage.sql.exec('SELECT payload FROM jobs WHERE id=?', id).one().payload)));
}
async function activeSource(count = 1) {
  const repoId = 'source-scope-real';
  const base = { repository: `yoneda-test/${repoId}`, commit: 'a'.repeat(40), tree: 'b'.repeat(40) };
  const body = new TextEncoder().encode('source fixture');
  const header = new TextEncoder().encode(`blob ${body.length}\0`);
  const joined = new Uint8Array(header.length + body.length); joined.set(header); joined.set(body, header.length);
  const blob = hex(await crypto.subtle.digest('SHA-1', joined));
  const artifacts = { readCommit: vi.fn(async () => ({ hash: base.commit, treeHash: base.tree })),
    readTree: vi.fn(async () => Array.from({ length: count }, (_, i) => ({ name: i === 0 ? 'app.js' : `source-${String(i).padStart(3, '0')}.bin`, hash: blob, mode: '100644', type: 'blob' }))),
    readBlob: vi.fn(async () => new Blob([body])), [Symbol.dispose]() {} } as unknown as ArtifactsRepo;
  const local = { ...bindings, ARTIFACTS: { get: vi.fn(async () => artifacts) } } as unknown as Env;
  await ledger(bindings, repoId, { op: 'init', id: repoId, name: 'Source scope fixture', workspace: 'source_owner',
    remote: { namespace: 'yoneda-test', name: repoId }, commit: base.commit, policy: reviewerPolicy });
  await ledger(bindings, repoId, { op: 'start_run', id: 'source-scope-run', intent: 'Check scoped source transport',
    workspace_transport: 'api-source-v1',
    _source_transport_approved: true, _source_base: base,
    agents: [{ provider: 'zai', model: 'glm-5.3-flash', strategy: 'Synthetic source scope' }] });
  const job = await ledger(bindings, repoId, { op: 'claim', job_id: 'job:source-scope-run:agent-1' });
  const scope = { repo_id: repoId, job, supervisor: 'synthetic-private-root', model_calls: 0, created_at: Date.now() } as Scope;
  let indexed = await sourceIndexBounded(local, base);
  while (indexed.state === 'preparing') indexed = await sourceIndexBounded(local, base);
  expect(indexed.state).toBe('prepared');
  return { env: local, scope, artifacts, base };
}

it('binds the active attempt once, refreshes without reading the index again, and denies cancelled/moved epochs', async () => {
  const f = await activeSource();
  const first = await sourceScope(f.env, f.scope, 'repo');
  const get = vi.spyOn(bindings.OBJECTS, 'get');
  const again = await sourceScope(f.env, f.scope, 'repo');
  expect(again.binding).toEqual(first.binding);
  expect(get).not.toHaveBeenCalled();
  get.mockRestore();
  await expect(sourceScope(f.env, { ...f.scope, job: { ...f.scope.job, epoch: f.scope.job.epoch + 1 } }, 'repo')).rejects.toMatchObject({ code: 'FENCED' });
  await ledger(bindings, f.scope.repo_id, { op: 'cancel_run', run_id: 'source-scope-run' });
  await expect(sourceScope(f.env, f.scope, 'repo')).rejects.toMatchObject({ code: 'FENCED' });
});

it('root endpoints and forged body authority are refused before initialization or R2 reads', async () => {
  const f = await activeSource();
  const local = { ...f.env, EXECUTIONS: { idFromString: (id: string) => id,
    get: () => ({ scope: async () => f.scope }) } } as unknown as Env;
  for (const path of ['/v1/repo/source_seal', '/v1/repo/source_gc_claim', '/v1/capture/context']) {
    const response = await sourceBroker(new Request(`http://source.yoneda.internal${path}`, { method: 'POST', body: '{}' }),
      local, { containerId: 'synthetic-container' } as never);
    expect(response.status).toBe(403);
  }
  const response = await sourceBroker(new Request('http://source.yoneda.internal/v1/repo/source_stat', {
    method: 'POST', body: JSON.stringify({ path: 'app.js', _actor: { claims: {} } }) }), local,
    { containerId: 'synthetic-container' } as never);
  expect(response.status).toBe(403);
  const context = await ledger(bindings, f.scope.repo_id, { op: 'source_read_context', job_id: f.scope.job.id });
  expect(context.bindings).toHaveLength(0);
});

it('current capture grant reads only the exact sealed manifest and cannot mutate or resurrect producer authority', async () => {
  const f = await sourceFixture('capture-grant-real');
  const cp = await f.rpc({ op: 'source_checkpoint', request_id: 'checkpoint', expected_workspace_version: 0 });
  const seal = await f.rpc({ op: 'source_seal', request_id: 'seal', expected_workspace_version: 0,
    checkpoint_id: cp.checkpoint_id, expected_checkpoint_digest: cp.changeset_digest });
  const claims = { version: 1, workspace_id: f.binding.workspace_id, binding_digest: await sourceFingerprint(f.binding),
    seal_id: seal.seal_id, checkpoint_id: seal.checkpoint_id, changeset_digest: seal.changeset_digest,
    capture_job_id: 'capture:source', capture_epoch: 2, expires_at: Date.now() + 60000, purpose: 'read_manifest' };
  const grant = { claims, signature: await sourceMac(bindings.VAULT_KEY, 'source-capture', claims) };
  const read: Json = { op: 'source_manifest', checkpoint_id: seal.checkpoint_id, section: 'view_files',
    limit: 1, _capture_grant: grant, _actor: null };
  const page = await f.rpc(read);
  expect(page.items).toHaveLength(1);
  expect(page.changeset_digest).toBe(seal.changeset_digest);
  await expect(f.rpc({ ...read, checkpoint_id: 'other' })).rejects.toBeDefined();
  await expect(f.rpc({ ...read, _capture_grant: { ...grant, signature: '0'.repeat(64) } })).rejects.toBeDefined();
  await expect(f.rpc({ ...read, op: 'source_delete', path: 'src/read.bin', request_id: 'capture-mutate',
    expected_workspace_version: 0, expected_file_version: 0 })).rejects.toBeDefined();
});

it('model mutations with a lost invalidation ACK retain the native receipt, replay it, and invalidate before successful ACK', async () => {
  const f = await activeSource();
  let failure = true;
  const invalidateSource = vi.fn(async () => {
    if (failure) throw Object.assign(new Error('Simulated unconfirmed root cache invalidation'), { code: 'SOURCE_UNCERTAIN' });
    return { invalidated: true, alias: 'repo', job_id: f.scope.job.id, epoch: f.scope.job.epoch };
  });
  const local = { ...f.env, EXECUTIONS: { idFromString: (id: string) => id,
    get: () => ({ scope: async () => f.scope, invalidateSource }) } } as unknown as Env;
  const command = { request_id: 'model-save', from: 'app.js', to: '_notes', expected_workspace_version: 0,
    expected_from_version: 0, expected_to_version: 0, overwrite: false };
  const send = () => sourceBroker(new Request('http://source.yoneda.internal/v1/repo/source_rename', {
    method: 'POST', body: JSON.stringify(command) }), local, { containerId: 'synthetic-container' } as never);
  const uncertain = await send();
  expect(uncertain.status).toBe(409);
  expect(await uncertain.json()).toMatchObject({ error: { code: 'SOURCE_UNCERTAIN' } });
  const bound = await sourceScope(f.env, f.scope, 'repo');
  const native = bindings.SOURCES.get(bindings.SOURCES.idFromName(bound.binding.workspace_id));
  const current = await native.fetch('http://source/command', { method: 'POST',
    body: JSON.stringify({ op: 'source_status', _actor: bound.actor }) });
  expect((await current.json()).workspace_version).toBe(1);
  failure = false;
  const replay = await send();
  expect(replay.status).toBe(200);
  expect((await replay.json()).file_versions).toEqual({ 'app.js': 1, _notes: 1 });
  expect(invalidateSource).toHaveBeenCalledTimes(2);
  expect(invalidateSource).toHaveBeenLastCalledWith({ alias: 'repo', paths: ['_notes', 'app.js'],
    job_id: f.scope.job.id, epoch: f.scope.job.epoch });
});

it('only an authenticated root FUSE request skips invalidation; a forged marker is denied before mutation', async () => {
  const f = await activeSource();
  const invalidateSource = vi.fn();
  const local = { ...f.env, EXECUTIONS: { idFromString: (id: string) => id,
    get: () => ({ scope: async () => f.scope, invalidateSource }) } } as unknown as Env;
  const command = { request_id: 'root-chmod', path: 'app.js', mode: '100755', expected_workspace_version: 0, expected_file_version: 0 };
  const send = (authorization?: string) => sourceBroker(new Request('http://source.yoneda.internal/v1/repo/source_chmod', {
    method: 'POST', headers: { 'x-yoneda-source-fuse': '1', ...(authorization ? { authorization } : {}) },
    body: JSON.stringify(command) }), local, { containerId: 'synthetic-container' } as never);
  expect((await send()).status).toBe(403);
  const untouched = await ledger(bindings, f.scope.repo_id, { op: 'source_read_context', job_id: f.scope.job.id });
  expect(untouched.bindings).toHaveLength(0);
  expect((await send(`Bearer ${f.scope.supervisor}`)).status).toBe(200);
  expect(invalidateSource).not.toHaveBeenCalled();
});

it('cancelled first-mount verification stops by the next bounded batch before binding or launching', async () => {
  const f = await activeSource(600);
  const ready = await ensureSourceIndex(f.env, f.base);
  if (ready.state !== 'prepared') throw new Error('Fixture source was not prepared');
  const original = bindings.OBJECTS.get.bind(bindings.OBJECTS);
  let proofs = 0;
  const get = vi.spyOn(bindings.OBJECTS, 'get').mockImplementation(async (...args) => {
    const value = await original(...args);
    if (String(args[0]).includes('/chunks/') && args[0] !== ready.manifest && ++proofs === 17)
      await ledger(bindings, f.scope.repo_id, { op: 'cancel_run', run_id: 'source-scope-run' });
    return value;
  });
  try {
    await expect(sourceScope(f.env, f.scope, 'repo')).rejects.toMatchObject({ code: 'FENCED' });
    expect(proofs).toBeLessThanOrEqual(32);
    const job = await storedJob(f.scope.repo_id, f.scope.job.id);
    expect(Object.keys(job.source_bindings ?? {})).toHaveLength(0);
    expect(job.runtime_started_at).toBeNull();
    expect(job.model_requests ?? 0).toBe(0);
  } finally { get.mockRestore(); }
});

it('first-mount heartbeats remain within the original deadline and leave runtime/model usage unstarted', async () => {
  const f = await activeSource(40);
  const heartbeats: Json[] = [];
  const repos = bindings.REPOSITORIES;
  const local = { ...f.env, REPOSITORIES: { idFromName: (name: string) => repos.idFromName(name),
    get: (id: DurableObjectId) => { const stub = repos.get(id); return { fetch: async (url: string, input: RequestInit) => {
      const c = JSON.parse(String(input.body));
      if (c.op === 'heartbeat') heartbeats.push(c);
      return stub.fetch(url, input);
    } }; } } } as unknown as Env;
  const before = await storedJob(f.scope.repo_id, f.scope.job.id);
  const get = vi.spyOn(bindings.OBJECTS, 'get');
  const head = vi.spyOn(bindings.OBJECTS, 'head');
  try {
    await sourceScope(local, f.scope, 'repo');
    expect(get.mock.calls.filter(([key]) => String(key).endsWith('.proof'))).toHaveLength(0);
    expect(head).not.toHaveBeenCalled();
  } finally { get.mockRestore(); head.mockRestore(); }
  expect(heartbeats.length).toBeGreaterThanOrEqual(3);
  expect(heartbeats.every(c => c.job_id === f.scope.job.id && c.epoch === f.scope.job.epoch)).toBe(true);
  const after = await storedJob(f.scope.repo_id, f.scope.job.id);
  expect(after.attempt_deadline).toBe(before.attempt_deadline);
  expect(after.lease_until).toBeLessThanOrEqual(before.attempt_deadline);
  expect(after.runtime_started_at).toBeNull();
  expect(after.model_requests ?? 0).toBe(0);
});
