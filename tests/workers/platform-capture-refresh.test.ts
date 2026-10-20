// Capture and refresh against the real platform: captures commit onto the attempt's own
// candidate branch through the broker's `commit` operation, and a stale candidate is refreshed
// by the platform's server-side merge, with the real ledger accepting every readback.
import { reset } from 'cloudflare:test';
import { afterEach, expect, it } from 'vitest';
import { refreshCandidate } from '../../cloudflare/worker/candidate-refresh';
import { recordPublicationChecks } from '../../cloudflare/worker/repository-recovery';
import { reviewerPolicy } from '../../cloudflare/worker/reviewer-policy';
import { sourceCapture } from '../../cloudflare/worker/source-capture';
import { ledger } from '../../cloudflare/worker/storage';
import type { Json } from '../../cloudflare/worker/types';
import { platformProject } from './platform-fixture';
import { attempt, commitSealed, lazyCandidate, sealedProducer } from './platform-source-fixture';
import { bindings, signup } from './reviewer-fixture';

afterEach(reset);
const owner = 'capture_owner';
const repo = 'platform-capture';
const baseFiles = { 'public/index.html': '<!doctype html><title>Base</title>\n' };
const call = (command: Json) => ledger(bindings, repo, command);

async function lazyRun(runs = ['run']) {
  const cookie = await signup(owner);
  const project = await platformProject(bindings, owner, repo, baseFiles, reviewerPolicy);
  for (const id of runs)
    await call({ op: 'start_run', id, intent: `Lazy-source platform capture ${id}`,
      workspace_transport: 'api-source-v1', _source_transport_approved: true, _source_base: project.base,
      agents: [{ provider: 'zai', model: 'glm-5.3-flash', strategy: 'minimal' }] });
  return { cookie, ...project };
}
const refs = async (f: Awaited<ReturnType<typeof lazyRun>>) => (await f.platform.call('GET', '/refs')).refs;

it('commits a sealed capture onto its assigned candidate branch and reuses it on retry', async () => {
  const f = await lazyRun();
  const files = { 'public/new.txt': 'sealed change\n' };
  const { capture } = await sealedProducer(bindings, repo, 'run:agent-1', f.base, files);
  const scope = attempt(repo, capture);
  const { body, committed } = await commitSealed(bindings, scope, baseFiles, files);
  const branch = scope.job.source_capture_ref.branch;
  expect(branch).toMatch(/^agents\/capture-[0-9a-f]{32}$/);
  expect(committed).toMatchObject({ verified: true, revision: { repository: `platform/${repo}` },
    tree: body.tree, parents: [f.base.commit] });
  expect((await refs(f))[`refs/heads/${branch}`]).toBe(committed.revision.commit);
  expect((await refs(f))['refs/heads/main']).toBe(f.base.commit);
  // A retried attempt finds its branch already holding the same tree and parents.
  const retried = await (await sourceCapture(bindings, scope, 'commit', body)).json<Json>();
  expect(retried.revision).toEqual(committed.revision);
  // A tree the platform does not reproduce, or foreign parents, never move the branch.
  await expect(sourceCapture(bindings, scope, 'commit', { ...body, tree: 'e'.repeat(40) }))
    .rejects.toMatchObject({ code: 'SOURCE_CHANGED' });
  await expect(sourceCapture(bindings, scope, 'commit', { ...body, parents: ['e'.repeat(40)] }))
    .rejects.toMatchObject({ code: 'SOURCE_SCOPE' });
  expect((await refs(f))[`refs/heads/${branch}`]).toBe(committed.revision.commit);
});

/** Publish candidate A as the owner (agent checks, owner approval and fast-forward land). */
async function publish(f: Awaited<ReturnType<typeof lazyRun>>, candidate: { id: string; revision: Json }) {
  const receipt = await call({ op: 'accept', request_id: `publish-${candidate.id}`, candidate: candidate.id,
    expected_commit: f.base.commit, expected_version: 0, rationale: 'Owner selects the first checked result' });
  await recordPublicationChecks(bindings, repo, receipt);
  for (const [path, body] of [[`/commits/${candidate.revision.commit}/reviews`, { decision: 'approve' }],
    ['/land', { ref: 'main', commit: candidate.revision.commit, fast_forward_only: true }]] as const) {
    const response = await bindings.SELF.fetch(`https://yoneda/api/v1/repos/${f.repo}${path}`, {
      method: 'POST', headers: { cookie: f.cookie, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    expect(response.status).toBe(200);
  }
  await call({ op: 'publication_readback', decision_id: receipt.id, observed_commit: candidate.revision.commit });
}

async function staleRefresh(conflicting: boolean) {
  // Two concurrent runs from the same base: publishing one makes the other's result stale.
  const f = await lazyRun(['first', 'second']);
  const first = await lazyCandidate(bindings, repo, 'first:agent-1', f.base, baseFiles, { 'public/a.txt': 'first\n' });
  const second = await lazyCandidate(bindings, repo, 'second:agent-1', f.base, baseFiles,
    conflicting ? { 'public/a.txt': 'second\n', 'public/c.txt': 'clean\n' } : { 'public/b.txt': 'second\n' });
  await publish(f, first);
  const receipt = await call({ op: 'refresh_candidate', request_id: 'refresh-second', candidate_id: second.id,
    expected_commit: first.revision.commit, expected_version: 1 });
  const job = await call({ op: 'claim', job_id: receipt.job_id });
  const command = await refreshCandidate(bindings, attempt(repo, job));
  return { f, first, second, receipt, command };
}

it('refreshes a stale candidate with a clean platform merge the ledger accepts as a new candidate', async () => {
  const { f, first, second, receipt, command } = await staleRefresh(false);
  expect(command).toMatchObject({ op: 'conflict_refresh_complete', result: { status: 'clean',
    paths: ['public/b.txt'], readback: { observed_head: first.revision.commit, version: 1,
      parents: [first.revision.commit, second.revision.commit] } } });
  const merged = command.result.merge_commit;
  // The refreshed revision is addressable on its own platform branch; main did not move.
  const all = await refs(f);
  expect(Object.entries(all).some(([ref, commit]) => ref.startsWith('refs/heads/agents/refresh-') && commit === merged)).toBe(true);
  expect(all['refs/heads/main']).toBe(first.revision.commit);
  await call(command);
  const conflict = await call({ op: 'snapshot' });
  expect(conflict.candidates.find((c: Json) => c.id === `candidate:refresh:${merged}`))
    .toMatchObject({ revision: { repository: `platform/${repo}`, commit: merged } });
  expect(receipt.status).toBe('refreshing');
});

it('records an unresolved refresh from a conflicting platform merge without inventing the resolution', async () => {
  const { f, first, second, command } = await staleRefresh(true);
  expect(command).toMatchObject({ op: 'conflict_refresh_complete', result: { status: 'unresolved',
    conflict_paths: ['public/a.txt'], readback: { observed_head: first.revision.commit, version: 1,
      parents: [first.revision.commit, second.revision.commit], conflict_paths: ['public/a.txt'] } } });
  // The workspace commit carries only the cleanly merged path; the conflict keeps main's bytes.
  const workspace = command.result.merge_workspace_commit;
  expect(command.result.workspace_revision).toEqual({ repository: `platform/${repo}`, commit: workspace });
  expect(command.result.readback.merged_paths).toEqual(['public/c.txt']);
  expect((await refs(f))['refs/heads/main']).toBe(first.revision.commit);
  const recorded = await call(command);
  expect(recorded).toMatchObject({ id: 'conflict:refresh-second', status: 'unresolved',
    merge_workspace_commit: workspace, conflict_paths_count: 1, merged_paths_count: 1,
    workspace_revision: { repository: `platform/${repo}`, commit: workspace } });
});
