import { env } from 'cloudflare:workers';
import { evictDurableObject, reset, runInDurableObject } from 'cloudflare:test';
import { afterEach, expect, it } from 'vitest';
import { ledger, object, readObject } from '../../cloudflare/worker/storage';
import type { Env, Json } from '../../cloudflare/worker/types';

const bindings = env as unknown as Env;
const repo = 'delegation-test';
const commit = 'a'.repeat(40);
const policy = {
  version: 'delegation-v1',
  suite: 'commands-v1',
  environment: 'linux-node24-rust1.94-v1',
  required_checks: ['build'],
  build: {
    setup: [],
    checks: [{ name: 'build', argv: ['node', '--check', 'app.js'], timeout_seconds: 30 }],
    static_dir: 'public',
  },
};
const agents = [
  { provider: 'mimo', connection: 'mimo-personal', model: 'mimo-v2.6-flash', strategy: 'minimal' },
  { provider: 'zai', connection: 'zai-team', model: 'glm-4.7-flash', strategy: 'accessible' },
  { provider: 'codex', connection: 'openai-personal', model: 'gpt-5.6-luna', strategy: 'structured' },
  { provider: 'claude', connection: 'anthropic-team', model: 'claude-sonnet-4-6', strategy: 'defensive' },
  { provider: 'gemini', connection: 'google-team', model: 'gemini-3.8-flash', strategy: 'editorial' },
  { provider: 'mimo', connection: 'mimo-team', model: 'mimo-v2.6-flash', strategy: 'responsive' },
];
const delegation = { enabled: true, max_depth: 2, max_executions: 12 };
const call = (command: Json) => ledger(bindings, repo, command);
const rootJob = (n = 1) => `job:scale:agent-${n}`;
const scoped = (job: Json) => ({ job_id: job.id, epoch: job.epoch });
const executions = (snapshot: Json, run = 'scale'): Json[] =>
  snapshot.executions.filter((execution: Json) => execution.run_id === run);

afterEach(async () => { await reset(); });

async function initialize(extra: Json = {}) {
  await call({ op: 'init', id: repo, name: 'Delegation', remote: { namespace: 'yoneda-test', name: repo }, commit, policy, ...extra });
}
async function start(extra: Json = {}) {
  return call({ op: 'start_run', id: 'scale', intent: 'Build an accessible website', criteria: ['Keyboard navigation'], agents, delegation, ...extra });
}
async function claim(job_id = rootJob()) {
  return call({ op: 'claim', job_id });
}
async function delegate(parent: Json, request_id = 'request-one', extra: Json = {}) {
  return call({ op: 'delegate_agent', ...scoped(parent), request_id, task: 'Check the navigation and record findings', strategy: 'navigation-review', ...extra });
}
async function state() {
  return call({ op: 'snapshot' });
}
async function pendingAgents() {
  const pending = await call({ op: 'outbox' });
  return pending.jobs.filter((job: Json) => job.kind === 'agent');
}
async function assertUnchanged(before: Json) {
  expect(await state()).toEqual(before);
}

it('rejects six-agent and delegated runs during ledger rollout while preserving ordinary older-ledger runs', async () => {
  const { checkLedger } = await import('../../cloudflare/worker/runtime');
  const old = { capabilities: { artifact_reads: 2 } };
  expect(() => checkLedger(old, { agents: agents.slice(0, 4) })).not.toThrow();
  expect(() => checkLedger(old, { agents })).toThrow('updating');
  expect(() => checkLedger(old, { agents: agents.slice(0, 2), delegation })).toThrow('updating');
  const current = { capabilities: { artifact_reads: 2, agent_limits: { max_root_agents: 6, max_delegation_depth: 2, max_run_executions: 12 } } };
  expect(() => checkLedger(current, { agents, delegation })).not.toThrow();
  expect(() => checkLedger(current, { agents: [...agents, agents[0]] })).toThrow('updating');
});

it('requires delegation-capable container images for delegated roots and children before model calls', async () => {
  const { checkRuntime } = await import('../../cloudflare/worker/runtime');
  const health = { protocol: 2, suites: ['commands-v1'] };
  const ordinary = { kind: 'agent', payload: { execution: { harness: 'claude' }, policy, run: {} } };
  expect(() => checkRuntime(health, ordinary)).not.toThrow();
  const root = { ...ordinary, payload: { ...ordinary.payload, run: { delegation } } };
  const child = { ...ordinary, payload: { ...ordinary.payload, execution: { harness: 'claude', parent_execution: 'scale:agent-1' } } };
  for (const job of [root, child]) {
    expect(() => checkRuntime(health, job)).toThrow('subagents');
    expect(() => checkRuntime({ ...health, capabilities: { agent_delegation: 1 } }, job)).not.toThrow();
  }
});

it('durably schedules six roots with identical source and policy, preserving each configured connection and model', async () => {
  await initialize();
  const run = await start();
  expect(run.execution_count).toBe(6);
  expect((await state()).capabilities.agent_limits).toEqual({ min_root_agents: 1, max_root_agents: 6, max_run_executions: 12, max_delegation_depth: 2, max_run_model_requests: null });
  expect(await pendingAgents()).toHaveLength(6);
  const claims = await Promise.all(agents.map((_, i) => claim(rootJob(i + 1))));
  claims.forEach((job, i) => {
    expect(job.payload.execution).toMatchObject({ provider: agents[i].provider, connection: agents[i].connection, model: agents[i].model, base: run.base });
    expect(job.payload.policy).toEqual(run.policy);
    expect(job.model).toBe(agents[i].model);
  });
  await evictDurableObject(bindings.REPOSITORIES.get(bindings.REPOSITORIES.idFromName(repo)));
  const snapshot = await state();
  expect(executions(snapshot)).toHaveLength(6);
  expect(executions(snapshot).every(execution => execution.status === 'running')).toBe(true);
  expect(snapshot.repository.published_commit).toBe(commit);
});

it('rejects invalid root and delegation limits without leaving executions, graph nodes, events or outbox jobs', async () => {
  await initialize();
  const before = await state();
  for (const extra of [
    { agents: [] },
    { agents: [...agents, { ...agents[0], strategy: 'seventh' }] },
    { delegation: { ...delegation, max_depth: 3 } },
    { delegation: { ...delegation, max_executions: 5 } },
    { delegation: { ...delegation, max_executions: 13 } },
  ]) {
    await expect(start(extra)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await assertUnchanged(before);
    expect(await pendingAgents()).toHaveLength(0);
  }
});

it('keeps delegation opt-in and does not spend the execution cap on an infrastructure retry', async () => {
  await initialize();
  const run = await start({ delegation: undefined });
  expect(run.delegation).toEqual({ enabled: false, max_depth: 0, max_executions: 6 });
  const parent = await claim();
  await expect(delegate(parent)).rejects.toMatchObject({ code: 'FORBIDDEN' });
  await call({ op: 'fail', ...scoped(parent), retryable: true, error: 'Simulated transient infrastructure failure' });
  const retried = await claim();
  expect(retried.epoch).toBe(parent.epoch + 1);
  expect(executions(await state())).toHaveLength(6);
  expect((await state()).runs[0].execution_count).toBe(6);
});

it('replays concurrent delegation once and rejects conflicting reuse of the parent-scoped request ID', async () => {
  await initialize();
  await start();
  const parent = await claim();
  const before = await state();
  const results = await Promise.all(Array.from({ length: 12 }, () => delegate(parent)));
  expect(new Set(results.map(result => result.execution.id)).size).toBe(1);
  expect(results.filter(result => result.replayed === false)).toHaveLength(1);
  expect(results.filter(result => result.replayed === true)).toHaveLength(11);
  const snapshot = await state();
  expect(executions(snapshot)).toHaveLength(7);
  expect(snapshot.seq).toBe(before.seq + 1);
  expect((await pendingAgents()).filter((job: Json) => job.payload.job_id === results[0].job_id)).toHaveLength(1);
  await expect(delegate(parent, 'request-one', { task: 'A different task' })).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
  await assertUnchanged(snapshot);
  const otherParent = await claim(rootJob(2));
  expect((await delegate(otherParent)).execution.id).not.toBe(results[0].execution.id);
});

it('freezes inherited authority and context while keeping descendant findings available to the parent', async () => {
  await initialize();
  await start({ id: 'seed', agents: agents.slice(0, 2), delegation: undefined });
  await call({ op: 'context_publish', record: { id: 'context:brief-keyboard', kind: 'requirement', statement: 'Navigation must support a keyboard', purpose: 'Accessibility', intent_id: 'intent:seed' } });
  const run = await start({ context: ['context:brief-keyboard'] });
  const parent = await claim();
  await call({ op: 'context_publish', ...scoped(parent), record: { id: 'finding:late-parent', kind: 'finding', statement: 'A later parent observation', purpose: 'Record discovery', intent_id: 'intent:scale' } });
  const delegated = await delegate(parent, 'inherit', { provider: 'claude', connection: 'another-account', model: 'expensive-override', parent_execution: 'forged-parent' });
  expect(delegated.execution).toMatchObject({ parent_execution: 'scale:agent-1', parent_epoch: parent.epoch, depth: 1, task: 'Check the navigation and record findings', provider: agents[0].provider, connection: agents[0].connection, model: agents[0].model, base: run.base, context: ['context:brief-keyboard'] });
  const child = await claim(delegated.job_id);
  expect(child.payload.run.context_records).toEqual(run.context_records);
  expect(child.payload.run.context_records.some((record: Json) => record.id === 'finding:late-parent')).toBe(false);
  expect(child.payload.policy).toEqual(run.policy);
  const finding = await call({ op: 'context_publish', ...scoped(child), record: { id: 'finding:child', kind: 'finding', statement: 'The skip link works with a keyboard', purpose: 'Report the assigned task', intent_id: 'intent:scale', author: 'owner', verified: true } });
  expect(finding.author).toBe(delegated.execution.id);
  expect(finding.data.authority).toBe('assertion');
  expect(finding.data.verified).toBeUndefined();
  const content = 'No-inference child review evidence';
  const stored = await object(bindings, content);
  await call({ op: 'publish_artifact', ...scoped(child), id: 'artifact:child', digest: stored.digest, label: 'Navigation review', kind: 'review' });
  const status = await call({ op: 'delegation_status', ...scoped(parent) });
  expect(status.children.map((execution: Json) => execution.id)).toContain(delegated.execution.id);
  expect(JSON.stringify(status.context)).toContain('finding:child');
  expect(JSON.stringify(status.context)).toContain('artifact:child');
  expect(await readObject(bindings, stored.digest)).toBe(content);
  expect((await state()).edges).toContainEqual(expect.objectContaining({ source: 'scale:agent-1', target: delegated.execution.id, relation: 'delegates_to' }));
});

it('enforces depth and the total execution cap atomically under competing delegation requests', async () => {
  await initialize();
  await start({ delegation: { ...delegation, max_executions: 8 } });
  const parent = await claim();
  const child = await claim((await delegate(parent)).job_id);
  const grandchild = await claim((await delegate(child, 'grandchild')).job_id);
  expect(grandchild.payload.execution.depth).toBe(2);
  const beforeDepth = await state();
  await expect(delegate(grandchild, 'too-deep')).rejects.toMatchObject({ code: 'RESOURCE_LIMIT' });
  await assertUnchanged(beforeDepth);
  const beforeCap = await state();
  const results = await Promise.allSettled(Array.from({ length: 5 }, (_, i) => delegate(parent, `over-cap-${i}`)));
  expect(results.every(result => result.status === 'rejected' && result.reason.code === 'RESOURCE_LIMIT')).toBe(true);
  await assertUnchanged(beforeCap);
  expect(executions(beforeCap)).toHaveLength(8);
  expect(beforeCap.runs[0].execution_count).toBe(8);
  expect(await pendingAgents()).toHaveLength(8);
});

it('admits only the available final slots when distinct requests race', async () => {
  await initialize();
  await start({ delegation: { ...delegation, max_executions: 8 } });
  const parent = await claim();
  const before = await state();
  const results = await Promise.allSettled(Array.from({ length: 6 }, (_, i) => delegate(parent, `race-${i}`)));
  expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(2);
  expect(results.filter(result => result.status === 'rejected' && result.reason.code === 'RESOURCE_LIMIT')).toHaveLength(4);
  const snapshot = await state();
  expect(executions(snapshot)).toHaveLength(8);
  expect(snapshot.runs[0].execution_count).toBe(8);
  expect(snapshot.seq).toBe(before.seq + 2);
  expect(await pendingAgents()).toHaveLength(8);
});

it('retains delegation identity across eviction and fences every descendant on cancellation', async () => {
  await initialize();
  await start();
  const parent = await claim();
  const first = await delegate(parent);
  const child = await claim(first.job_id);
  const grandchild = await claim((await delegate(child, 'grandchild')).job_id);
  await evictDurableObject(bindings.REPOSITORIES.get(bindings.REPOSITORIES.idFromName(repo)));
  expect((await delegate(parent)).execution.id).toBe(first.execution.id);
  const cancelled = await call({ op: 'cancel_run', run_id: 'scale' });
  expect(cancelled.stop.map((stop: Json) => stop.job_id)).toEqual(expect.arrayContaining([parent.id, child.id, grandchild.id]));
  for (const job of [parent, child, grandchild]) {
    await expect(call({ op: 'check_attempt', ...scoped(job) })).rejects.toMatchObject({ code: 'FENCED' });
    await expect(delegate(job, 'late')).rejects.toMatchObject({ code: 'FENCED' });
  }
  const snapshot = await state();
  expect(executions(snapshot).every(execution => execution.status === 'cancelled')).toBe(true);
  expect(snapshot.repository.published_commit).toBe(commit);
});

it('fences the old subtree when its parent fails and retries, without inheriting that subtree into the next epoch', async () => {
  await initialize();
  await start();
  const parent = await claim();
  const child = await claim((await delegate(parent)).job_id);
  const grandchild = await claim((await delegate(child, 'grandchild')).job_id);
  await call({ op: 'fail', ...scoped(parent), retryable: true, error: 'Simulated interrupted parent' });
  const retry = await claim();
  for (const job of [parent, child, grandchild]) {
    await expect(call({ op: 'check_attempt', ...scoped(job) })).rejects.toMatchObject({ code: 'FENCED' });
  }
  await expect(delegate(retry)).rejects.toMatchObject({ code: 'FENCED' });
  const replacement = await delegate(retry, 'replacement');
  expect(replacement.execution.parent_epoch).toBe(retry.epoch);
  expect(replacement.execution.id).not.toBe(child.payload.execution.id);
  expect((await state()).runs[0].execution_count).toBe(9);
});

it('allows issued children to finish after their parent completes while retaining independent capture and selection gates', async () => {
  await initialize();
  await start();
  const parent = await claim();
  const child = await claim((await delegate(parent)).job_id);
  const workspace = await object(bindings, JSON.stringify({ files: { 'public/index.html': { content: '<!doctype html><title>Fixture</title>' } } }));
  await call({ op: 'finish', ...scoped(parent), result: { workspace: workspace.digest } });
  await call({ op: 'check_attempt', ...scoped(child) });
  await call({ op: 'finish', ...scoped(child), result: { workspace: workspace.digest } });
  const capture = await claim(`capture:${child.payload.execution.id}`);
  expect(capture.kind).toBe('capture');
  await expect(delegate(capture, 'capture-cannot-delegate')).rejects.toMatchObject({ code: 'FORBIDDEN' });
  const nextPolicy = { ...policy, version: 'delegation-v2' };
  await call({ op: 'update_policy', expected_commit: commit, expected_version: 0, expected_policy: policy.version, policy: nextPolicy });
  // Synthetic capture fixture exercises authority transitions, not Git or build execution.
  await call({ op: 'finish', ...scoped(capture), result: { id: 'child-candidate', revision: { repository: 'yoneda-test/fixture-fork', commit: 'c'.repeat(40) }, tree: 'd'.repeat(40), paths: ['public/index.html'], diff: 'fixture diff', summary: 'Child result' } });
  const evaluator = await claim('evaluate:child-candidate');
  expect(evaluator.payload.policy.version).toBe('delegation-v2');
  await expect(delegate(evaluator, 'evaluator-cannot-delegate')).rejects.toMatchObject({ code: 'FORBIDDEN' });
  await expect(call({ op: 'accept', request_id: 'unverified-selection', candidate: 'child-candidate', expected_commit: commit, expected_version: 0, rationale: 'An agent claim is insufficient' })).rejects.toMatchObject({ code: 'MISSING_EVIDENCE' });
  expect((await state()).repository.published_commit).toBe(commit);
});

it('denies research and external contribution attempts the hosted delegation capability', async () => {
  await initialize({ policy: { version: 'retry-v1', suite: 'retry-contract-v1', environment: 'rust-1.94-evaluator-v1', required_checks: ['build', 'behavior'] } });
  await call({ op: 'start_run', id: 'research', intent: 'Research a retry policy' });
  const research = await claim('job:research:research');
  await expect(delegate(research)).rejects.toMatchObject({ code: 'FORBIDDEN' });
  const external = await call({ op: 'external_begin', id: 'external-test', _grant: 'grant-test', intent: 'Contribute locally', fork: 'yoneda-test/external-fork' });
  await expect(delegate(external)).rejects.toMatchObject({ code: 'FORBIDDEN' });
});

it('cannot select an already eligible descendant after its parent fails', async () => {
  await initialize();
  await start();
  const parent = await claim();
  const child = await claim((await delegate(parent)).job_id);
  const files = { 'index.html': { content: '<!doctype html><title>Eligible fixture</title>' } };
  const workspace = await object(bindings, JSON.stringify({ files: { 'public/index.html': files['index.html'] } }));
  await call({ op: 'finish', ...scoped(child), result: { workspace: workspace.digest } });
  const capture = await claim(`capture:${child.payload.execution.id}`);
  // Independent capture/evaluation observations are synthetic fixtures, not paid executions.
  const revision = { repository: 'yoneda-test/fixture-fork', commit: 'c'.repeat(40) };
  await call({ op: 'finish', ...scoped(capture), result: { id: 'eligible-child', revision, tree: 'd'.repeat(40), paths: ['public/index.html'], diff: 'fixture diff', summary: 'Eligible child fixture' } });
  const evaluator = await claim('evaluate:eligible-child');
  const site = await object(bindings, JSON.stringify({ repo, revision, files }));
  await call({ op: 'register_site', ...scoped(evaluator), digest: site.digest, files });
  await call({ op: 'verify_finish', ...scoped(evaluator), report: { suite: policy.suite, environment: policy.environment, setup: [], commands: [{ name: 'build', output: { exit: 0 } }] }, evidence: (await object(bindings, 'Synthetic successful evaluator observations')).digest });
  expect((await state()).candidates.find((candidate: Json) => candidate.id === 'eligible-child').status).toBe('eligible');
  await call({ op: 'fail', ...scoped(parent), retryable: true, error: 'Simulated parent failure after child evaluation' });
  const before = await state();
  await expect(call({ op: 'accept', request_id: 'fenced-child-selection', candidate: 'eligible-child', expected_commit: commit, expected_version: 0, rationale: 'Old subtree must never ship after parent failure' })).rejects.toMatchObject({ code: 'FENCED' });
  await assertUnchanged(before);
  expect(before.repository.published_commit).toBe(commit);
  expect(before.decisions).toHaveLength(0);
});

it('preserves historical aggregate limits across roots and descendants without paid inference', async () => {
  await initialize();
  await start();
  await runInDurableObject(bindings.REPOSITORIES.get(bindings.REPOSITORIES.idFromName(repo)), (_instance, state) => {
    state.storage.sql.exec("UPDATE runs SET payload=json_remove(payload,'$.model_budgets','$.request_limits')");
  });
  const roots = await Promise.all(agents.map((_, i) => claim(rootJob(i + 1))));
  const child = await claim((await delegate(roots[0])).job_id);
  // Reservations exercise real SQLite counters. No provider or container is called.
  for (let round = 0; round < 24; round++) {
    await Promise.all(roots.map(root => call({ op: 'reserve_request', ...scoped(root), kind: 'model' })));
  }
  await evictDurableObject(bindings.REPOSITORIES.get(bindings.REPOSITORIES.idFromName(repo)));
  expect((await state()).runs[0].model_requests).toBe(144);
  const before = await state();
  await expect(call({ op: 'reserve_request', ...scoped(child), kind: 'model' })).rejects.toMatchObject({ code: 'RESOURCE_LIMIT' });
  await assertUnchanged(before);
  const status = await call({ op: 'delegation_status', ...scoped(roots[0]) });
  expect(status.model_requests).toBe(144);
});
