import { reset, runInDurableObject } from 'cloudflare:test';
import { afterEach, expect, it, vi } from 'vitest';
import { hex } from '../../cloudflare/worker/source-crypto';
import { sourceRoute } from '../../cloudflare/worker/source-route';
import { ledger } from '../../cloudflare/worker/storage';
import type { Env } from '../../cloudflare/worker/types';
import { bindings } from '../../tools/source-benchmark/workerd-source-fixture';
import { reviewerPolicy } from '../../cloudflare/worker/reviewer-policy';

afterEach(reset);
async function ownerSource(count = 3) {
  const repo = 'owner-source-legacy';
  const revision = { repository: `yoneda-test/${repo}`, commit: 'a'.repeat(40), tree: 'b'.repeat(40) };
  const bytes = new Uint8Array([0, 255, 10]);
  const prefix = new TextEncoder().encode(`blob ${bytes.length}\0`);
  const joined = new Uint8Array(prefix.length + bytes.length); joined.set(prefix); joined.set(bytes, prefix.length);
  const blob = hex(await crypto.subtle.digest('SHA-1', joined));
  const artifacts = { readCommit: vi.fn(async () => ({ hash: revision.commit, treeHash: revision.tree })),
    readTree: vi.fn(async () => Array.from({ length: count }, (_, index) => ({ name: `file-${String(index).padStart(3, '0')}.bin`,
      hash: blob, mode: '100644', type: 'blob' }))), readBlob: vi.fn(async () => new Blob([bytes])), [Symbol.dispose]() {} } as unknown as ArtifactsRepo;
  const local = { ...bindings, ARTIFACTS: { get: vi.fn(async () => artifacts) } } as unknown as Env;
  await ledger(bindings, repo, { op: 'init', id: repo, name: 'Legacy immutable owner view', workspace: 'source_owner',
    remote: { namespace: 'yoneda-test', name: repo }, commit: revision.commit, policy: reviewerPolicy });
  const stub = bindings.REPOSITORIES.get(bindings.REPOSITORIES.idFromName(repo));
  // Synthetic immutable historical capture; no active producer, no grants or paid start.
  await runInDurableObject(stub, (_instance, state) => {
    state.storage.sql.exec('INSERT INTO candidates(id,payload) VALUES(?,?)', 'historical', JSON.stringify({
      id: 'historical', revision: { repository: revision.repository, commit: revision.commit }, tree: revision.tree, status: 'eligible' }));
  });
  const principal = { workspace: 'source_owner', role: 'user' as const };
  const read = (op: string, query = 'candidate_id=historical') => sourceRoute(
    new Request(`https://local/api/repos/${repo}/source/${op}?${query}`), local, principal, repo);
  return { repo, revision, bytes, blob, env: local, artifacts, principal, read };
}

it('prepares a small historical candidate inline without reviving any producer and preserves exact raw file identity', async () => {
  const f = await ownerSource();
  const listed = await f.read('list');
  expect(listed?.status).toBe(200);
  const page = await listed?.json();
  expect(page.items).toHaveLength(3);
  expect(page.revision).toEqual(f.revision);
  expect(page.candidate_id).toBe('historical');
  const read = await f.read('file', 'candidate_id=historical&path=file-000.bin&offset=0&limit=65536');
  expect(new Uint8Array(await read!.arrayBuffer())).toEqual(f.bytes);
  const metadata = JSON.parse(decodeURIComponent(read!.headers.get('x-yoneda-source') ?? ''));
  expect(metadata.authority).toBe('git');
  expect(metadata.file.blob_id).toBe(f.blob);
  expect(f.artifacts.readBlob).toHaveBeenCalledTimes(1);
  const provenance = await (await f.read('provenance', 'candidate_id=historical&path=file-000.bin'))?.json();
  expect(provenance.coverage).toBe('unknown');
  expect(provenance.authority).toBe('git');
  expect(provenance.provenance_authority).toBe('recorded_file_provenance');
  expect(provenance.context).toEqual([]);
});

it('returns actionable preparation and makes bounded progress on each refresh for a larger historical capture', async () => {
  const f = await ownerSource(20);
  const first = await f.read('list');
  expect(first?.status).toBe(409);
  expect(await first?.json()).toMatchObject({ preparation: 'preparing', retry_action: 'refresh_source', error: { code: 'SOURCE_PREPARING' } });
  const second = await f.read('list');
  expect(second?.status).toBe(200);
  expect((await second?.json()).items).toHaveLength(20);
});

it('foreign workspace and caller hash selectors fail before any Artifacts or R2 indexing', async () => {
  const f = await ownerSource();
  const get = vi.spyOn(bindings.OBJECTS, 'get');
  const foreign = await sourceRoute(new Request(`https://local/api/repos/${f.repo}/source/list?candidate_id=historical`),
    f.env, { role: 'user', workspace: 'other_owner' }, f.repo);
  expect(foreign?.status).toBe(403);
  const forged = await f.read('list', 'candidate_id=historical&commit=' + 'e'.repeat(40));
  expect(forged?.status).toBe(409);
  expect(f.artifacts.readCommit).not.toHaveBeenCalled();
  expect(get).not.toHaveBeenCalled();
  get.mockRestore();
});
