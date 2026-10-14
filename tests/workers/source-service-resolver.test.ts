import { reset, runInDurableObject } from 'cloudflare:test';
import { afterEach, expect, it } from 'vitest';
import { reviewerPolicy } from '../../cloudflare/worker/reviewer-policy';
import { sourceAuthority } from '../../cloudflare/worker/source-authority';
import { hex } from '../../cloudflare/worker/source-crypto';
import { sourceIndexBounded } from '../../cloudflare/worker/source-index';
import { activateSourceMounts, sourceScope } from '../../cloudflare/worker/source-scope';
import { ledger } from '../../cloudflare/worker/storage';
import type { Env, Scope } from '../../cloudflare/worker/types';
import { bindings } from '../../tools/source-benchmark/workerd-source-fixture';

afterEach(reset);
it('mounts the native resolver target with preserved clean edits and both actual readonly sides without writable scratch', async () => {
  const repo = 'source-native-resolver';
  const runId = 'resolver-run';
  const initial = { repository: 'yoneda-test/solver-head', commit: 'a'.repeat(40), tree: 'b'.repeat(40) };
  await ledger(bindings, repo, { op: 'init', id: repo, name: 'Synthetic resolver views', workspace: 'source_owner',
    remote: { namespace: 'yoneda-test', name: 'solver-head' }, commit: initial.commit, policy: reviewerPolicy });
  await ledger(bindings, repo, { op: 'start_run', id: runId, intent: 'Resolve only frozen conflicts',
    workspace_transport: 'api-source-v1', _source_transport_approved: true, _source_base: initial,
    agents: [{ provider: 'zai', model: 'glm-5.3-flash', strategy: 'Synthetic resolver' }] });
  const jobId = `job:${runId}:agent-1`;
  await ledger(bindings, repo, { op: 'claim', job_id: jobId });
  const target = { repository: initial.repository, commit: 'c'.repeat(40) };
  const candidate = { id: 'original-candidate', run_id: runId, revision: { repository: 'yoneda-test/solver-candidate', commit: 'f'.repeat(40) }, tree: 'd'.repeat(40) };
  const merge = { repository: 'yoneda-test/solver-merge', commit: 'e'.repeat(40) };
  const stub = bindings.REPOSITORIES.get(bindings.REPOSITORIES.idFromName(repo));
  // Seed trusted synthetic premerge history exactly as the native fixture; no paid resolver execution.
  await runInDurableObject(stub, (_instance, state) => {
    const sql = state.storage.sql;
    const get = (table: string, id: string) => JSON.parse(String(sql.exec(`SELECT payload FROM ${table} WHERE id=?`, id).one().payload));
    const save = (table: string, id: string, value: unknown) => sql.exec(`UPDATE ${table} SET payload=? WHERE id=?`, JSON.stringify(value), id);
    const r = get('repository', 'repo'); r.head_commit = target.commit; r.version = 1; save('repository', 'repo', r);
    const execution = get('executions', `${runId}:agent-1`);
    execution.base = target; execution.conflict_id = 'conflict'; execution.conflict_paths = ['conflict.rs'];
    save('executions', execution.id, execution);
    const job = get('jobs', jobId);
    job.payload.execution = execution; job.payload.conflict_resolver = { conflict_id: 'conflict' };
    job.payload.team_owned_paths = ['conflict.rs']; save('jobs', jobId, job);
    sql.exec('INSERT INTO conflicts(id,payload) VALUES(?,?)', 'conflict', JSON.stringify({ id: 'conflict', status: 'resolving',
      resolver_job_id: jobId, resolver_execution_id: execution.id, head_commit: target.commit, expected_version: 1,
      target_revision: target, expected_head_tree: 'd'.repeat(40), candidate, candidate_revision: candidate.revision.commit,
      workspace_revision: merge, merge_workspace_commit: merge.commit, merge_tree: 'b'.repeat(40),
      conflict_paths: ['conflict.rs'], merged_paths: ['clean.rs', 'conflict.rs'] }));
  });
  const context = await ledger(bindings, repo, { op: 'source_read_context', job_id: jobId, epoch: 1 });
  expect(context.source_resolution).toBe(true);
  const bytes = new TextEncoder().encode('synthetic preserved content');
  const prefix = new TextEncoder().encode(`blob ${bytes.length}\0`);
  const raw = new Uint8Array(prefix.length + bytes.length); raw.set(prefix); raw.set(bytes, prefix.length);
  const blob = hex(await crypto.subtle.digest('SHA-1', raw));
  const local = { ...bindings, ARTIFACTS: { get: async (name: string) => {
    const ref = context.inputs.find((input: any) => input.repository === `yoneda-test/${name}`);
    return { readCommit: async () => ({ hash: ref.commit, treeHash: ref.tree }),
      readTree: async () => ['clean.rs', 'conflict.rs'].map(path => ({ name: path, mode: '100644', type: 'blob', hash: blob })),
      readBlob: async () => new Blob([bytes]), [Symbol.dispose]() {} } as unknown as ArtifactsRepo;
  } } } as unknown as Env;
  for (const input of context.inputs) expect((await sourceIndexBounded(local, input)).state).toBe('prepared');
  const scope = { repo_id: repo, job: { id: jobId, epoch: 1, kind: 'agent' }, supervisor: 'synthetic-root', model_calls: 0, created_at: Date.now() } as Scope;
  const mounts = await activateSourceMounts(local, scope);
  expect(mounts.map(m => [m.path, m.access])).toEqual([['repo', 'read_write'], ['candidate-0', 'read_only'], ['candidate-1', 'read_only']]);
  expect(mounts.slice(1).every(m => m.scratch_paths.length === 0)).toBe(true);
  for (const alias of ['candidate-0', 'candidate-1'] as const) {
    const side = await sourceScope(local, scope, alias);
    await expect(sourceAuthority(local, side.binding.workspace_id, { op: 'source_chmod', request_id: `deny-${alias}`,
      expected_workspace_version: 0, expected_file_version: 0, path: 'conflict.rs', mode: '100755', _actor: side.actor })).rejects.toMatchObject({ code: 'FORBIDDEN' });
  }
  const primary = await sourceScope(local, scope, 'repo');
  const clean = await sourceAuthority<any>(local, primary.binding.workspace_id, { op: 'source_stat', path: 'clean.rs', _actor: primary.actor });
  expect(clean.content.repository).toBe(merge.repository);
  expect(primary.binding.write_paths).toEqual(['conflict.rs']);
  expect(scope.model_calls).toBe(0);
});
