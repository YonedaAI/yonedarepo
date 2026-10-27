// Refresh against the real platform: a stale sandbox candidate is refreshed by the platform's
// server-side merge, with the real ledger accepting every readback.
import { reset } from 'cloudflare:test';
import { afterEach, expect, it } from 'vitest';
import { refreshCandidate } from '../../cloudflare/worker/candidate-refresh';
import { recordPublicationChecks } from '../../cloudflare/worker/repository-recovery';
import { reviewerPolicy } from '../../cloudflare/worker/reviewer-policy';
import { object } from '../../cloudflare/worker/storage';
import type { Json } from '../../cloudflare/worker/types';
import { platformCommit, platformProject } from './platform-fixture';
import { bindings, signup } from './reviewer-fixture';
import { approvedLedger, finishSandbox, sandboxStart } from './source-kit';

afterEach(reset);
const owner = 'capture_owner';
const repo = 'platform-capture';
const baseFiles = { 'public/index.html': '<!doctype html><title>Base</title>\n' };
const call = approvedLedger(bindings, repo);

async function sandboxRuns(runs: string[]) {
  const cookie = await signup(owner);
  const project = await platformProject(bindings, owner, repo, baseFiles, reviewerPolicy);
  for (const id of runs)
    await call({ op: 'start_run', id, intent: `Sandbox platform change ${id}`, ...sandboxStart(project.base),
      agents: [{ provider: 'zai', model: 'glm-5.3-flash', strategy: 'minimal' }] });
  return { cookie, ...project };
}
type Runs = Awaited<ReturnType<typeof sandboxRuns>>;
const refs = async (f: Runs) => (await f.platform.call('GET', '/refs')).refs;

/** A checked, eligible candidate: the commit the run's sandbox agent pushed on its base. */
async function sandboxCandidate(f: Runs, run: string, files: Record<string, string>) {
  const made = await platformCommit(f.platform, f.base.commit, files);
  const agent = await call({ op: 'claim', job_id: `job:${run}:agent-1` });
  const id = `candidate-${run}`;
  await finishSandbox(bindings, repo, agent, f.base, made, { id, paths: Object.keys(files) });
  const evaluator = await call({ op: 'claim', job_id: `evaluate:${id}` });
  const policy = evaluator.payload.policy;
  const revision = { repository: f.base.repository, commit: made.commit };
  const site = { 'index.html': { content: `<!doctype html><title>${id}</title>` } };
  await call({ op: 'register_site', job_id: evaluator.id, epoch: evaluator.epoch,
    digest: (await object(bindings, JSON.stringify({ repo, revision, files: site }))).digest, files: site });
  await call({ op: 'verify_finish', job_id: evaluator.id, epoch: evaluator.epoch,
    evidence: (await object(bindings, `Synthetic evaluator observations for ${id}`)).digest,
    report: { suite: policy.suite, environment: policy.environment,
      setup: policy.build.setup.map((check: Json) => ({ name: check.name, output: { exit: 0 } })),
      commands: policy.build.checks.map((check: Json) => ({ name: check.name, output: { exit: 0 } })) } });
  return { id, revision };
}

/** Publish candidate A as the owner (agent checks, owner approval and fast-forward land). */
async function publish(f: Runs, candidate: { id: string; revision: Json }) {
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
  const f = await sandboxRuns(['first', 'second']);
  const first = await sandboxCandidate(f, 'first', { 'public/a.txt': 'first\n' });
  const second = await sandboxCandidate(f, 'second',
    conflicting ? { 'public/a.txt': 'second\n', 'public/c.txt': 'clean\n' } : { 'public/b.txt': 'second\n' });
  await publish(f, first);
  const receipt = await call({ op: 'refresh_candidate', request_id: 'refresh-second', candidate_id: second.id,
    expected_commit: first.revision.commit, expected_version: 1 });
  const job = await call({ op: 'claim', job_id: receipt.job_id });
  const command = await refreshCandidate(bindings, { repo_id: repo, job });
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
