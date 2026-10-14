import { reset, runInDurableObject } from 'cloudflare:test';
import { afterEach, expect, it, vi } from 'vitest';
import { sourceBroker } from '../../cloudflare/worker/source-broker';
import { sourceRefresh } from '../../cloudflare/worker/source-refresh';
import { reviewerPolicy } from '../../cloudflare/worker/reviewer-policy';
import { sourceFingerprint } from '../../cloudflare/worker/source-crypto';
import { compareSourcePaths } from '../../cloudflare/worker/source-path';
import { ledger, sha } from '../../cloudflare/worker/storage';
import type { Env, Json, Scope } from '../../cloudflare/worker/types';
import { bindings } from '../../tools/source-benchmark/workerd-source-fixture';

afterEach(reset);

/** Native RPC is a fixed wire fixture here; R2 and the Worker transport execute in workerd. */
function fixture() {
  const base = { repository: 'yoneda-test/refresh-base', commit: 'a'.repeat(40) };
  const head = { repository: base.repository, commit: 'c'.repeat(40) };
  const candidate = { repository: 'yoneda-test/refresh-candidate', commit: 'e'.repeat(40), tree: 'f'.repeat(40) };
  const scope = { repo_id: 'refresh-repo', job: { id: 'capture:refresh:bounded', epoch: 2, kind: 'capture',
    payload: { workspace_transport: 'api-source-v1', capture_subtype: 'refresh_candidate' },
    source_capture_ref: { branch: 'release/booking', expected_head: head.commit } },
    supervisor: 'synthetic-root', fork: 'yoneda-test/refresh-out', model_calls: 0, created_at: Date.now() } as Scope;
  const frozen = { version: 1, job_id: scope.job.id, epoch: 2, conflict_id: 'conflict:bounded', base, head, candidate,
    declared_paths: ['booking.bin'], declared_paths_ref: null, expected_version: 4 };
  const native = vi.fn(async (_url: string, request: RequestInit) => {
    const command = JSON.parse(String(request.body));
    if (command.op === 'check_attempt') return Response.json({ active: true });
    if (command.op !== 'source_refresh_paths') return Response.json(frozen);
    const paths = ['booking.bin', '\uE000', '🚀'];
    const authority = { version: 1, digest: (frozen as Json).declared_paths_ref.digest,
      total: (frozen as Json).declared_paths_ref.count, paths_ref: frozen.declared_paths_ref };
    if (command.path !== undefined) return Response.json({ ...authority, allowed: paths.includes(command.path) });
    const selected = paths.filter(path => compareSourcePaths(path, command.after ?? '') > 0);
    const items = selected.slice(0, command.limit);
    const more = selected.length > items.length;
    return Response.json({ ...authority, items, has_more: more, next_cursor: more ? items.at(-1) : null });
  });
  let closure = true;
  let tip = '1'.repeat(40);
  const commit = (hash: string, tree: string, parents: string[]) => ({ hash, treeHash: tree, parents });
  const get = vi.fn(async (name: string) => ({
    readCommit: async (hash: string) => {
      if (hash === base.commit) return commit(hash, 'b'.repeat(40), []);
      if (hash === head.commit) return commit(hash, 'd'.repeat(40), [base.commit]);
      if (hash === candidate.commit && (name !== 'refresh-out' || closure)) return commit(hash, candidate.tree, [base.commit]);
      if (hash === '1'.repeat(40) && name === 'refresh-out') return commit(hash, '2'.repeat(40), [head.commit, candidate.commit]);
      return null;
    },
    readTree: async () => [{ name: 'booking.bin', hash: '3'.repeat(40), mode: '100644', type: 'blob' }],
    readBlob: vi.fn(), log: vi.fn(async () => [{ hash: tip }]), [Symbol.dispose]() {},
  }) as unknown as ArtifactsRepo);
  const env = { ...bindings, ARTIFACTS: { get }, REPOSITORIES: { idFromName: (name: string) => name,
    get: () => ({ fetch: native }) }, EXECUTIONS: { idFromString: (id: string) => id,
    get: () => ({ scope: async () => scope }) } } as unknown as Env;
  const send = (op: string, args: Json = {}, root = true) => sourceBroker(new Request(`http://source.yoneda.internal/v1/refresh/${op}`, {
    method: 'POST', headers: root ? { authorization: `Bearer ${scope.supervisor}` } : {}, body: JSON.stringify(args) }),
    env, { containerId: 'fixture-container' } as never);
  return { env, scope, frozen, get, native, send, setClosure: (value: boolean) => { closure = value; }, setTip: (value: string) => { tip = value; } };
}

it('denies models and caller authority selectors before any Git or R2 access', async () => {
  const f = fixture();
  expect((await f.send('context', {}, false)).status).toBe(403);
  expect((await f.send('tree', { input: 'head', repository: 'foreign', path: '' })).status).toBe(403);
  expect((await f.send('blob', { input: 'head', path: 'private-key' })).status).toBe(403);
  expect((await f.send('blob', { input: 'other', path: 'booking.bin' })).status).toBe(403);
  expect(f.get).not.toHaveBeenCalled();
});

it('hydrates only current native refs and rejects epoch changes before SDK access', async () => {
  const f = fixture();
  const result = await f.send('context');
  expect(result.status).toBe(200);
  expect(await result.json()).toMatchObject({ version: 1, targetVersion: 4, declaredPaths: ['booking.bin'],
    candidateParents: [f.frozen.base.commit], head: { ...f.frozen.head, tree: 'd'.repeat(40) },
    source_capture_ref: f.scope.job.source_capture_ref });
  f.get.mockClear();
  f.frozen.epoch++;
  expect((await f.send('context')).status).toBe(409);
  expect(f.get).not.toHaveBeenCalled();
});

it('merge verification rejects swapped parents, missing candidate closure and stale assigned branch readback', async () => {
  const f = fixture();
  const value = { commit: '1'.repeat(40), tree: '2'.repeat(40), parents: [f.frozen.head.commit, f.frozen.candidate.commit] };
  expect((await f.send('verify', { ...value, parents: [...value.parents].reverse() })).status).toBe(403);
  expect(f.get).not.toHaveBeenCalled();
  f.setClosure(false);
  expect((await f.send('verify', value)).status).toBe(409);
  f.setClosure(true); f.setTip(f.frozen.head.commit);
  expect((await f.send('verify', value)).status).toBe(409);
  f.setTip(value.commit);
  expect(await (await f.send('verify', value)).json()).toMatchObject({ verified: true,
    revision: { repository: f.scope.fork, commit: value.commit }, parents: value.parents });
});

it('never reinterprets a compact path reference as an empty declared scope', async () => {
  const f = fixture();
  f.frozen.declared_paths = [];
  const digest = await sourceFingerprint(['booking.bin', '\uE000', '🚀']);
  f.frozen.declared_paths_ref = { version: 1, id: `paths:${digest}`, digest, count: 3 } as never;
  const context = await (await f.send('context')).json<Json>();
  expect(context.declaredPaths).toBeUndefined();
  expect(context.declaredPathsRef).toEqual(f.frozen.declared_paths_ref);
  f.get.mockClear();
  expect((await f.send('blob', { input: 'head', path: 'private-key' })).status).toBe(403);
  expect(f.get).not.toHaveBeenCalled();
  const membership = f.native.mock.calls.map(([, input]) => JSON.parse(String(input.body))).find(c => c.path === 'private-key');
  expect(membership).toEqual({ op: 'source_refresh_paths', job_id: f.scope.job.id, epoch: 2, expected_digest: digest, path: 'private-key' });
});

it('keeps refresh paths paginated with a pinned digest and exact Unicode string cursors', async () => {
  const f = fixture();
  const digest = await sourceFingerprint(['booking.bin', '\uE000', '🚀']);
  f.frozen.declared_paths = [];
  f.frozen.declared_paths_ref = { version: 1, id: `paths:${digest}`, digest, count: 3 } as never;
  const first = await (await f.send('paths', { after: null, limit: 2, expectedDigest: digest })).json();
  expect(first).toMatchObject({ items: ['booking.bin', '\uE000'], next_cursor: '\uE000', total: 3, digest });
  const second = await (await f.send('paths', { after: '\uE000', limit: 2, expectedDigest: digest })).json();
  expect(second).toMatchObject({ items: ['🚀'], next_cursor: null });
  expect((await f.send('paths', { after: '\uE000', limit: 2, expectedDigest: '0'.repeat(64) })).status).toBe(409);
  expect((await f.send('paths', { after: 2, limit: 2, expectedDigest: digest })).status).toBe(409);
  expect(f.get).not.toHaveBeenCalled();
});

it('checks the exact candidate preload and job-derived temporary ref without accepting any caller selector', async () => {
  const f = fixture();
  expect((await f.send('verify_input', { ref: 'refs/heads/other' })).status).toBe(403);
  expect(f.get).not.toHaveBeenCalled();
  f.setTip(f.frozen.candidate.commit);
  expect(await (await f.send('verify_input')).json()).toMatchObject({ verified: true,
    revision: { repository: f.scope.fork, commit: f.frozen.candidate.commit },
    tree: f.frozen.candidate.tree, parents: [f.frozen.base.commit] });
  const fork = f.get.mock.results.at(-1);
  expect(vi.mocked((await fork?.value).log)).toHaveBeenCalledWith({
    ref: `refs/yoneda/source-input/${await sha(f.scope.job.id)}`, limit: 1 });
  f.setClosure(false);
  expect((await f.send('verify_input')).status).toBe(409);
});

it('serves compact refresh context, Unicode pages and indexed membership through the actual native Repo DO', async () => {
  const f = fixture();
  const repo = 'actual-refresh-native';
  await ledger(bindings, repo, { op: 'init', id: repo, name: 'Synthetic recorded refresh', workspace: 'source_owner',
    remote: { namespace: 'yoneda-test', name: 'refresh-base' }, commit: f.frozen.base.commit, policy: reviewerPolicy });
  await ledger(bindings, repo, { op: 'start_run', id: 'native-refresh-run', intent: 'Local sparse refresh fixture',
    workspace_transport: 'api-source-v1', _source_transport_approved: true,
    _source_base: { ...f.frozen.base, tree: 'b'.repeat(40) },
    agents: [{ provider: 'zai', model: 'glm-5.3-flash', strategy: 'Synthetic refresh scope' }] });
  const stub = bindings.REPOSITORIES.get(bindings.REPOSITORIES.idFromName(repo));
  // Synthetic historical checked candidate only; no harness, provider, publication or network.
  await runInDurableObject(stub, (_instance, state) => {
    const sql = state.storage.sql;
    sql.exec('INSERT INTO candidates(id,payload) VALUES(?,?)', 'native-candidate', JSON.stringify({
      id: 'native-candidate', run_id: 'native-refresh-run', execution: 'native-refresh-run:agent-1',
      base: f.frozen.base, revision: { repository: f.frozen.candidate.repository, commit: f.frozen.candidate.commit },
      tree: f.frozen.candidate.tree, paths: ['booking.bin', '\uE000', '🚀'], status: 'eligible', evaluation: 'synthetic-checked' }));
    const current = JSON.parse(String(sql.exec("SELECT payload FROM repository WHERE id='repo'").one().payload));
    current.head_commit = f.frozen.head.commit; current.version = 1;
    sql.exec("UPDATE repository SET payload=? WHERE id='repo'", JSON.stringify(current));
  });
  const receipt = await ledger(bindings, repo, { op: 'refresh_candidate', request_id: 'native-path-pages',
    candidate_id: 'native-candidate', expected_commit: f.frozen.head.commit, expected_version: 1 });
  const job = await ledger(bindings, repo, { op: 'claim', job_id: receipt.job_id });
  expect(job.payload.workspace_transport).toBe('api-source-v1');
  f.scope.repo_id = repo;
  f.scope.job = { ...job, source_capture_ref: f.scope.job.source_capture_ref };
  const env = { ...f.env, REPOSITORIES: bindings.REPOSITORIES };
  const send = (op: string, body: Json) => sourceBroker(new Request(`http://source.yoneda.internal/v1/refresh/${op}`, {
    method: 'POST', headers: { authorization: `Bearer ${f.scope.supervisor}` }, body: JSON.stringify(body) }),
    env, { containerId: 'fixture-container' } as never);
  const header = await (await send('context', {})).json<Json>();
  expect(header.declaredPaths).toBeUndefined();
  expect(header.declaredPathsRef.count).toBe(3);
  expect(new TextEncoder().encode(JSON.stringify(header)).length).toBeLessThan(2048);
  const first = await (await send('paths', { after: null, limit: 2, expectedDigest: header.declaredPathsRef.digest })).json<Json>();
  expect(first).toMatchObject({ version: 1, items: ['booking.bin', '\uE000'], next_cursor: '\uE000', total: 3 });
  const second = await (await send('paths', { after: first.next_cursor, limit: 2, expectedDigest: header.declaredPathsRef.digest })).json<Json>();
  expect(second).toMatchObject({ items: ['🚀'], next_cursor: null });
  f.get.mockClear();
  expect((await send('blob', { input: 'head', path: 'unapproved.bin' })).status).toBe(403);
  expect(f.get).not.toHaveBeenCalled();
  await runInDurableObject(stub, (_instance, state) => {
    const current = JSON.parse(String(state.storage.sql.exec("SELECT payload FROM repository WHERE id='repo'").one().payload));
    current.version++;
    state.storage.sql.exec("UPDATE repository SET payload=? WHERE id='repo'", JSON.stringify(current));
  });
  expect((await send('paths', { after: first.next_cursor, limit: 2, expectedDigest: header.declaredPathsRef.digest })).status).toBe(409);
  expect(f.get).not.toHaveBeenCalled();
});
