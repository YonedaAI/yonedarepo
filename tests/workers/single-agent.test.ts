import { env } from 'cloudflare:workers';
import { evictDurableObject, reset } from 'cloudflare:test';
import { afterEach, expect, it } from 'vitest';
import { checkLedger } from '../../cloudflare/worker/runtime';
import { ledger, object } from '../../cloudflare/worker/storage';
import type { Env, Json } from '../../cloudflare/worker/types';

const bindings = env as unknown as Env;
const repo = 'single-agent-test';
const call = (command: Json) => ledger(bindings, repo, command);
const policy = {
  version: 'single-v1', suite: 'commands-v1', environment: 'linux-node24-rust1.94-v1',
  required_checks: ['build'],
  build: { setup: [], checks: [{ name: 'build', argv: ['node', '--check', 'app.js'], timeout_seconds: 30 }], static_dir: 'public' },
};
const agents = [
  { provider: 'mimo', connection: 'mimo-personal', model: 'mimo-v2.6-flash', strategy: 'minimal' },
  { provider: 'zai', connection: 'zai-personal', model: 'glm-4.7-flash', strategy: 'accessible' },
];
afterEach(async () => { await reset(); });

it('fences single-agent requests during ledger rollout without blocking supported older multi-agent runs', () => {
  const old = { capabilities: { artifact_reads: 2 } };
  const previous = { capabilities: { artifact_reads: 2, agent_limits: { min_root_agents: 2, max_root_agents: 6 } } };
  const current = { capabilities: { artifact_reads: 2, agent_limits: { min_root_agents: 1, max_root_agents: 6 } } };
  for (const snapshot of [old, previous]) {
    expect(() => checkLedger(snapshot, { agents: agents.slice(1) })).toThrow('updating');
    expect(() => checkLedger(snapshot, { agents })).not.toThrow();
  }
  expect(() => checkLedger(current, { agents: agents.slice(1) })).not.toThrow();
});

async function checkedCandidate(run: string, index: number, commit: string) {
  const execution = `${run}:agent-${index}`;
  const agent = await call({ op: 'claim', job_id: `job:${execution}` });
  const files = { 'index.html': { content: '<!doctype html><title>Ledger fixture</title>' } };
  const workspace = await object(bindings, JSON.stringify({ files: { 'public/index.html': files['index.html'] } }));
  await call({ op: 'finish', job_id: agent.id, epoch: agent.epoch, result: { workspace: workspace.digest } });
  const capture = await call({ op: 'claim', job_id: `capture:${execution}` });
  const candidate = `candidate-${run}-${index}`;
  const revision = { repository: 'yoneda-test/fixture-fork', commit };
  // Synthetic observations exercise real DO/R2 transitions, without invoking Git, builds or models.
  await call({ op: 'finish', job_id: capture.id, epoch: capture.epoch, result: { id: candidate, revision, tree: 'f'.repeat(40), paths: ['public/index.html'], diff: 'fixture diff', summary: 'Website fixture' } });
  const evaluator = await call({ op: 'claim', job_id: `evaluate:${candidate}` });
  const site = await object(bindings, JSON.stringify({ repo, revision, files }));
  await call({ op: 'register_site', job_id: evaluator.id, epoch: evaluator.epoch, digest: site.digest, files });
  await call({ op: 'verify_finish', job_id: evaluator.id, epoch: evaluator.epoch, report: { suite: policy.suite, environment: policy.environment, setup: [], commands: [{ name: 'build', output: { exit: 0 } }] }, evidence: (await object(bindings, 'Synthetic successful evaluator observations')).digest });
  return candidate;
}
async function publish(candidate: string, request_id: string, commit: string) {
  const snapshot = await call({ op: 'snapshot' });
  const receipt = await call({ op: 'accept', request_id, candidate, expected_commit: snapshot.repository.head_commit, expected_version: snapshot.repository.version, rationale: 'Owner selects an independently checked website', alternatives: [] });
  const publisher = await call({ op: 'claim', job_id: `publish:${receipt.id}` });
  await call({ op: 'finish', job_id: publisher.id, epoch: publisher.epoch, result: { commit } });
}

it('publishes a single-agent update from the canonical two-agent release while preserving its history across eviction', async () => {
  await call({ op: 'init', id: repo, name: 'Website', remote: { namespace: 'yoneda-test', name: repo }, commit: 'a'.repeat(40), policy });
  await call({ op: 'start_run', id: 'initial', intent: 'Build a website', agents });
  const selected = await checkedCandidate('initial', 1, 'b'.repeat(40));
  await checkedCandidate('initial', 2, 'c'.repeat(40));
  await publish(selected, 'initial-choice', 'b'.repeat(40));
  const before = await call({ op: 'snapshot' });
  const remaining = agents.slice(1);
  checkLedger(before, { agents: remaining });
  const update = await call({ op: 'start_run', id: 'update', intent: 'Improve the website', agents: remaining, context: ['intent:initial'] });
  expect(update).toMatchObject({ base: { repository: `yoneda-test/${repo}`, commit: 'b'.repeat(40) }, base_version: 1, execution_count: 1, delegation: { enabled: false, max_depth: 0, max_executions: 1 } });
  expect(update.model_budgets).toHaveLength(1);
  expect(update.model_budgets[0]).toMatchObject({ provider: 'zai', model: agents[1].model, requests: 0 });
  const candidate = await checkedCandidate('update', 1, 'd'.repeat(40));
  await publish(candidate, 'update-choice', 'd'.repeat(40));
  await evictDurableObject(bindings.REPOSITORIES.get(bindings.REPOSITORIES.idFromName(repo)));
  const after = await call({ op: 'snapshot' });
  expect(after.capabilities.agent_limits.min_root_agents).toBe(1);
  expect(after.repository).toMatchObject({ published_commit: 'd'.repeat(40), site: { commit: 'd'.repeat(40) } });
  expect(after.executions.filter((execution: Json) => execution.run_id === 'update')).toHaveLength(1);
  for (const table of ['runs', 'executions', 'candidates', 'evaluations', 'decisions']) {
    for (const historical of before[table]) expect(after[table]).toContainEqual(historical);
  }
});
