import { reset, runInDurableObject } from 'cloudflare:test';
import { afterEach, expect, it } from 'vitest';
import { reviewerPolicy } from '../../cloudflare/worker/reviewer-policy';
import { ledger } from '../../cloudflare/worker/storage';
import type { Json } from '../../cloudflare/worker/types';
import { bindings } from '../../tools/source-benchmark/workerd-source-fixture';

afterEach(reset);

/**
 * The Worker-side candidate refresh (candidate-refresh.ts) reads its reservation through these
 * private ledger operations of the actual native Repo DO: a compact header, then declared paths
 * paged under a pinned digest, all fenced by the reserved target version.
 */
async function reservedRefresh() {
  const repo = 'actual-refresh-native';
  const project = `platform/${repo}`;
  const base = { repository: project, commit: 'a'.repeat(40) };
  const head = { repository: project, commit: 'c'.repeat(40) };
  const candidate = { repository: project, commit: 'e'.repeat(40), tree: 'f'.repeat(40) };
  const call = (command: Json) => ledger(bindings, repo, command);
  await call({ op: 'init', id: repo, name: 'Synthetic recorded refresh', workspace: 'source_owner',
    remote: { namespace: 'platform', name: repo, branch: 'main' }, commit: base.commit, policy: reviewerPolicy });
  await call({ op: 'start_run', id: 'native-refresh-run', intent: 'Local sparse refresh fixture',
    workspace_transport: 'api-source-v1', _source_transport_approved: true,
    _source_base: { ...base, tree: 'b'.repeat(40) },
    agents: [{ provider: 'zai', model: 'glm-5.3-flash', strategy: 'Synthetic refresh scope' }] });
  const stub = bindings.REPOSITORIES.get(bindings.REPOSITORIES.idFromName(repo));
  // Synthetic historical checked candidate only; no harness, provider, publication or network.
  await runInDurableObject(stub, (_instance, state) => {
    const sql = state.storage.sql;
    sql.exec('INSERT INTO candidates(id,payload) VALUES(?,?)', 'native-candidate', JSON.stringify({
      id: 'native-candidate', run_id: 'native-refresh-run', execution: 'native-refresh-run:agent-1',
      base, revision: { repository: candidate.repository, commit: candidate.commit },
      tree: candidate.tree, paths: ['booking.bin', '', '🚀'], status: 'eligible', evaluation: 'synthetic-checked' }));
    const current = JSON.parse(String(sql.exec("SELECT payload FROM repository WHERE id='repo'").one().payload));
    current.head_commit = head.commit; current.version = 1;
    sql.exec("UPDATE repository SET payload=? WHERE id='repo'", JSON.stringify(current));
  });
  const receipt = await call({ op: 'refresh_candidate', request_id: 'native-path-pages',
    candidate_id: 'native-candidate', expected_commit: head.commit, expected_version: 1 });
  const job = await call({ op: 'claim', job_id: receipt.job_id });
  const identity = { job_id: job.id, epoch: job.epoch };
  return { repo, stub, call, job, identity, base, head, candidate };
}

it('serves a compact frozen header whose declared scope is a path reference, never an empty list', async () => {
  const f = await reservedRefresh();
  expect(f.job.payload).toMatchObject({ workspace_transport: 'api-source-v1', capture_subtype: 'refresh_candidate' });
  const header = await f.call({ op: 'source_refresh_context', ...f.identity });
  expect(header).toMatchObject({ version: 1, base: f.base, head: f.head, candidate: f.candidate, expected_version: 1 });
  expect(header.declared_paths).toBeUndefined();
  expect(header.declared_paths_ref).toMatchObject({ version: 1, count: 3 });
  expect(new TextEncoder().encode(JSON.stringify(header)).length).toBeLessThan(2048);
});

it('pages declared paths with a pinned digest and exact Unicode string cursors through the actual Repo DO', async () => {
  const f = await reservedRefresh();
  const header = await f.call({ op: 'source_refresh_context', ...f.identity });
  const digest = header.declared_paths_ref.digest;
  const page = (after: unknown, expected_digest = digest) =>
    f.call({ op: 'source_refresh_paths', ...f.identity, limit: 2, expected_digest, ...(after === null ? {} : { after }) });
  const first = await page(null);
  expect(first).toMatchObject({ items: ['booking.bin', ''], has_more: true, next_cursor: '' });
  const second = await page(first.next_cursor);
  expect(second).toMatchObject({ items: ['🚀'], has_more: false, next_cursor: null });
  await expect(page(first.next_cursor, '0'.repeat(64))).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
  await expect(page(2)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  const membership = await f.call({ op: 'source_refresh_paths', ...f.identity, expected_digest: digest, path: 'unapproved.bin' });
  expect(membership.allowed).toBe(false);
});

it('fences the reservation once the target version moves or the epoch is stale', async () => {
  const f = await reservedRefresh();
  const header = await f.call({ op: 'source_refresh_context', ...f.identity });
  await expect(f.call({ op: 'source_refresh_context', ...f.identity, epoch: f.job.epoch + 1 })).rejects.toMatchObject({ code: 'FENCED' });
  await runInDurableObject(f.stub, (_instance, state) => {
    const current = JSON.parse(String(state.storage.sql.exec("SELECT payload FROM repository WHERE id='repo'").one().payload));
    current.version++;
    state.storage.sql.exec("UPDATE repository SET payload=? WHERE id='repo'", JSON.stringify(current));
  });
  await expect(f.call({ op: 'source_refresh_paths', ...f.identity, limit: 2,
    expected_digest: header.declared_paths_ref.digest })).rejects.toMatchObject({ code: 'HEAD_MOVED' });
});
