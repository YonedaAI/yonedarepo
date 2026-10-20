import { env } from 'cloudflare:workers';
import { approveComparisonStart } from '../../cloudflare/worker/comparison-approval';
import { resolveAdaptiveApproval } from '../../cloudflare/worker/adaptive-approval';
import { ledger, object } from '../../cloudflare/worker/storage';
import type { Env, Json } from '../../cloudflare/worker/types';
import { workspace } from '../../cloudflare/worker/workspace';
import { platformCommit, platformProject } from './platform-fixture';

export const bindings = env as unknown as Env;
export const repo = 'comparison-boundary-fixture';
export const runId = 'legacy-comparison';
export const initialCommit = 'a'.repeat(40);
export const owner = 'comparison_user';
export const policy = {
  version: 'comparison-v1', suite: 'commands-v1', environment: 'linux-node24-rust1.94-v1',
  required_checks: ['build'],
  build: { setup: [], checks: [{ name: 'build', argv: ['node', '--check', 'app.js'], timeout_seconds: 30 }], static_dir: 'public' },
};
export const agents = ['minimal', 'accessible'].map(strategy => ({
  provider: 'zai', model: 'glm-5.3-flash', connection: `test-${strategy}`, strategy,
}));
export const call = (command: Json) => ledger(bindings, repo, command);

async function signup() {
  await workspace(bindings, owner, { op: 'signup', username: owner,
    password: 'Synthetic comparison test password', salt: '01'.repeat(16),
    recovery_hash: 'b'.repeat(64), session_hash: 'a'.repeat(64) });
}
async function repository() {
  await signup();
  await call({ op: 'init', id: repo, name: 'Comparison boundary fixture',
    workspace: owner, remote: { namespace: 'yoneda-test', name: repo }, commit: initialCommit, policy });
  await call({ op: 'create_working_branch', id: 'development',
    expected_commit: initialCommit, expected_version: 0 });
}

export async function legacyCompare(modelBudgets?: Json[], builders: Json[] = agents) {
  await repository();
  return call({ op: 'start_run', id: runId, mode: 'compare',
    intent: 'Compare booking capacity implementations before selecting one',
    agents: builders, working_branch_id: 'development', expected_working_commit: initialCommit,
    expected_working_version: 0, ...(modelBudgets ? { model_budgets: modelBudgets } : {}) });
}

export function modernCompareApproval() {
  const connections = [
    { id: 'sol-builder', provider: 'codex', model: 'gpt-6-sol', version: 1 },
    { id: 'sonnet-builder', provider: 'claude', model: 'claude-sonnet-5-5', version: 1 },
    { id: 'glm-reviewer', provider: 'zai', model: 'glm-5.3-flash', version: 1 },
  ];
  const fixed = resolveAdaptiveApproval({ mode: 'compare', adaptive_team: { version: 1,
    requested_agents: [
      { connection: 'sol-builder', role: 'builder' },
      { connection: 'sonnet-builder', role: 'builder' },
    ] } }, connections, 50000000, false);
  return approveComparisonStart({ ...fixed, comparison: { version: 1 } }, connections, 50000000);
}

export async function newCompare() {
  await repository();
  await workspace(bindings, owner, { op: 'workspace_spend_configure',
    expected_version: 0, limit_microusd: 50000000 });
  return call({ ...modernCompareApproval(), op: 'start_run', id: runId,
    intent: 'Compare booking capacity implementations before selecting one',
    working_branch_id: 'development', expected_working_commit: initialCommit,
    expected_working_version: 0 });
}

export async function readyReview() {
  await newCompare();
  const first = await checkedBuilder(1, 'b'.repeat(40));
  const second = await checkedBuilder(2, 'c'.repeat(40));
  const detail = await call({ op: 'run_detail', run_id: runId });
  const job = await call({ op: 'claim', job_id: `job:${detail.run.comparison.review_execution_id}` });
  const context = await call({ op: 'comparison_context', job_id: job.id, epoch: job.epoch });
  return { first, second, job, context };
}

export function selectionArguments(context: Json) {
  return { request_id: 'checked-comparison-selection', manifest_digest: context.manifest_digest,
    outcome: 'selected', candidate_id: context.manifest.alternatives[0].candidate_id,
    rationale: 'Capacity-safe booking transactions preserve registration integrity',
    alternatives: context.manifest.alternatives.map((alternative: Json) => ({
      candidate_id: alternative.candidate_id, execution_id: alternative.execution_id,
      reason: 'Independent build checks pass for this exact captured approach',
    })), risks: [], evidence_refs: [] };
}

/** Synthetic runner observations exercise actual repository DO transactions and R2. */
export async function checkedBuilder(index: number, commit: string, active?: Json,
  at: { repository: string; tree: string } = { repository: `yoneda-test/builder-${index}`, tree: 'f'.repeat(40) }) {
  const execution = `${runId}:agent-${index}`;
  const builder = active ?? await call({ op: 'claim', job_id: `job:${execution}` });
  const files = { 'index.html': { content: `<!doctype html><title>Builder ${index}</title>` } };
  const workspace = await object(bindings, JSON.stringify({ files: { 'public/index.html': files['index.html'] } }));
  await call({ op: 'finish', job_id: builder.id, epoch: builder.epoch, result: { workspace: workspace.digest } });
  const capture = await call({ op: 'claim', job_id: `capture:${execution}` });
  const id = `candidate-${index}`;
  const revision = { repository: at.repository, commit };
  await call({ op: 'finish', job_id: capture.id, epoch: capture.epoch, result: {
    id, revision, tree: at.tree, paths: ['public/index.html'], diff: `Booking approach ${index}`,
    summary: `Checked capacity implementation ${index}`,
  } });
  const evaluator = await call({ op: 'claim', job_id: `evaluate:${id}` });
  const site = await object(bindings, JSON.stringify({ repo, revision, files }));
  await call({ op: 'register_site', job_id: evaluator.id, epoch: evaluator.epoch, digest: site.digest, files });
  const evidence = await object(bindings, `Synthetic independent build observations ${index}`);
  await call({ op: 'verify_finish', job_id: evaluator.id, epoch: evaluator.epoch,
    report: { suite: policy.suite, environment: policy.environment,
      setup: [], commands: [{ name: 'build', output: { exit: 0 } }] }, evidence: evidence.digest });
  return { id, revision };
}

/** A ready review whose project and both captured builders are real platform commits. */
export async function platformReadyReview() {
  await signup();
  const { base, platform } = await platformProject(bindings, owner, repo, { 'app.js': 'void 0;\n' }, policy);
  await call({ op: 'create_working_branch', id: 'development', expected_commit: base.commit, expected_version: 0 });
  await workspace(bindings, owner, { op: 'workspace_spend_configure', expected_version: 0, limit_microusd: 50000000 });
  await call({ ...modernCompareApproval(), op: 'start_run', id: runId,
    intent: 'Compare booking capacity implementations before selecting one',
    working_branch_id: 'development', expected_working_commit: base.commit, expected_working_version: 0 });
  const built = [];
  for (const index of [1, 2]) {
    const made = await platformCommit(platform, base.commit,
      { 'public/index.html': `<!doctype html><title>Builder ${index}</title>\n` });
    built.push(await checkedBuilder(index, made.commit, undefined, { repository: base.repository, tree: made.tree }));
  }
  const detail = await call({ op: 'run_detail', run_id: runId });
  const job = await call({ op: 'claim', job_id: `job:${detail.run.comparison.review_execution_id}` });
  return { base, first: built[0], second: built[1], job };
}
