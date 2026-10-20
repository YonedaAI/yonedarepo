// Publication end to end on the real platform: the agent layer records its checks with the
// project's agent token (which can never land), the owner approves and lands with their own
// session, and only the platform's readback of `main` completes or blocks the decision.
import { reset } from 'cloudflare:test';
import { afterEach, expect, it } from 'vitest';
import { ledger, object } from '../../cloudflare/worker/storage';
import type { Json } from '../../cloudflare/worker/types';
import { platformCommit, platformProject } from './platform-fixture';
import { api, bindings, signup } from './reviewer-fixture';
import { approvedLedger, finishSealed, withLineage } from './source-kit';

afterEach(reset);
const owner = 'publish_owner';
const repo = 'platform-publication';
const policy = {
  version: 'publish-v1', suite: 'commands-v1', environment: 'linux-node24-rust1.94-v1',
  required_checks: ['build'],
  build: { setup: [], checks: [{ name: 'build', argv: ['node', '--check', 'app.js'], timeout_seconds: 30 }] },
};
const call = approvedLedger(bindings, repo);

async function fixture() {
  const cookie = await signup(owner);
  const project = await platformProject(bindings, owner, repo, { 'app.js': 'void 0;\n' }, policy);
  // The owner's own session against the platform's public API.
  const owned = async (path: string, body?: Json) => {
    const response = await bindings.SELF.fetch(`https://yoneda/api/v1/repos/${project.repo}${path}`, {
      method: body ? 'POST' : 'GET', headers: { cookie, 'content-type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, body: await response.json<Json>() };
  };
  return { cookie, owned, ...project };
}

/** A checked candidate whose capture is a real commit on the project's platform repository. */
async function checkedCandidate(f: Awaited<ReturnType<typeof fixture>>, run: string, content: string) {
  await call({ op: 'start_run', id: run, intent: 'Improve the app',
    agents: [{ provider: 'zai', model: 'glm-5.3-flash', strategy: 'minimal' }] });
  const status = await call({ op: 'repository_status' });
  const made = await platformCommit(f.platform, status.head_commit, { 'app.js': content });
  const agent = await call({ op: 'claim', job_id: `job:${run}:agent-1` });
  const registration = await finishSealed(bindings, repo, agent);
  const capture = await call({ op: 'claim', job_id: `capture:${run}:agent-1` });
  const id = `candidate-${run}`;
  await call({ op: 'finish', job_id: capture.id, epoch: capture.epoch, result: withLineage(registration, { id,
    revision: { repository: f.base.repository, commit: made.commit }, tree: made.tree,
    paths: ['app.js'], diff: 'app diff', summary: 'Checked app change' }) });
  const evaluator = await call({ op: 'claim', job_id: `evaluate:${id}` });
  await call({ op: 'verify_finish', job_id: evaluator.id, epoch: evaluator.epoch,
    report: { suite: policy.suite, environment: policy.environment, setup: [], commands: [{ name: 'build', output: { exit: 0 } }] },
    evidence: (await object(bindings, `Synthetic evaluator observations for ${run}`)).digest });
  return { id, ...made };
}

async function accept(f: Awaited<ReturnType<typeof fixture>>, candidate: string, request_id: string) {
  const status = await call({ op: 'repository_status' });
  const response = await api(bindings, `/api/repos/${repo}/accept`, f.cookie, { request_id, candidate,
    expected_commit: status.head_commit, expected_version: status.version, rationale: 'Owner selects the checked change' });
  expect(response.status).toBe(200);
  return response.json<Json>();
}

it('records agent checks, lets only the owner land fast-forward, and completes from the platform readback', async () => {
  const f = await fixture();
  const candidate = await checkedCandidate(f, 'first', 'export const app = 1;\n');
  const receipt = await accept(f, candidate.id, 'first-choice');
  expect(receipt.publication).toMatchObject({ platform_repo: f.repo, ref: 'main', commit: candidate.commit,
    expected: f.base.commit, break_glass: false });
  // The agent layer recorded its independent checks on the exact commit.
  const gated = await f.owned(`/commits/${candidate.commit}`);
  expect(JSON.stringify(gated.body)).toContain('yoneda-checks');
  // Before the owner lands, readback leaves the decision pending.
  const early = await api(bindings, `/api/repos/${repo}/publication_readback`, f.cookie, { decision_id: receipt.id });
  expect((await early.json<Json>()).status).toBe('publication_pending');
  // The agent token cannot approve or land; the owner's own session can.
  await expect(f.platform.call('POST', '/land', { ref: 'main', commit: candidate.commit, fast_forward_only: true }))
    .rejects.toMatchObject({ status: 403 });
  expect((await f.owned(`/commits/${candidate.commit}/reviews`, { decision: 'approve' })).status).toBe(200);
  const landed = await f.owned('/land', { ref: 'main', commit: candidate.commit, fast_forward_only: true });
  expect(landed.body).toMatchObject({ landed: true, commit: candidate.commit });
  const readback = await api(bindings, `/api/repos/${repo}/publication_readback`, f.cookie, { decision_id: receipt.id });
  expect(readback.status).toBe(200);
  const decision = await readback.json<Json>();
  expect(decision).toMatchObject({ status: 'published' });
  expect(typeof decision.land_version).toBe('number');
  expect((await call({ op: 'repository_status' }))).toMatchObject({ head_commit: candidate.commit, published_commit: candidate.commit });
  // Readback is idempotent and a foreign session cannot drive it.
  expect((await api(bindings, `/api/repos/${repo}/publication_readback`, f.cookie, { decision_id: receipt.id })).status).toBe(200);
  const foreign = await signup('publish_foreign');
  expect((await api(bindings, `/api/repos/${repo}/publication_readback`, foreign, { decision_id: receipt.id })).status).toBe(403);
});

it('blocks on a main moved elsewhere and resynchronizes from the platform head, never a supplied commit', async () => {
  const f = await fixture();
  const candidate = await checkedCandidate(f, 'first', 'export const app = 1;\n');
  const receipt = await accept(f, candidate.id, 'first-choice');
  // Another change lands first (checked by the agent token, approved and landed by the owner).
  const other = await platformCommit(f.platform, f.base.commit, { 'app.js': 'export const other = 2;\n' });
  await f.platform.call('POST', `/commits/${other.commit}/checks`, { name: 'yoneda-checks', status: 'pass', evidence: 'other' });
  expect((await f.owned(`/commits/${other.commit}/reviews`, { decision: 'approve' })).status).toBe(200);
  expect((await f.owned('/land', { ref: 'main', commit: other.commit, fast_forward_only: true })).body.landed).toBe(true);
  // The selected commit can no longer fast-forward: the owner's land is refused, nothing merges.
  expect((await f.owned(`/commits/${candidate.commit}/reviews`, { decision: 'approve' })).status).toBe(200);
  const stale = await f.owned('/land', { ref: 'main', commit: candidate.commit, fast_forward_only: true });
  expect([stale.status, stale.body.error?.code]).toEqual([409, 'STALE_HEAD']);
  const conflict = await (await api(bindings, `/api/repos/${repo}/publication_readback`, f.cookie, { decision_id: receipt.id })).json<Json>();
  expect(conflict).toMatchObject({ status: 'publication_conflict', observed: { conflict: true, commit: other.commit } });
  const blocked = await call({ op: 'repository_status' });
  expect(blocked.status).toBe('blocked');
  const resync = await api(bindings, `/api/repos/${repo}/resync_repository`, f.cookie, {
    expected_version: blocked.version, expected_pending: receipt.id, observed_commit: candidate.commit });
  expect(resync.status).toBe(200);
  expect(await resync.json()).toMatchObject({ status: 'ready', head_commit: other.commit, published_commit: other.commit });
});
