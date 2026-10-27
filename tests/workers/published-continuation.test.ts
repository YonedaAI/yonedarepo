import { env } from 'cloudflare:workers';
import { evictDurableObject, reset } from 'cloudflare:test';
import { afterEach, expect, it } from 'vitest';
import { checkLedger } from '../../cloudflare/worker/runtime';
import { object } from '../../cloudflare/worker/storage';
import type { Env, Json } from '../../cloudflare/worker/types';
import { approvedLedger, finishSandbox, sandboxStart } from './source-kit';

const bindings = env as unknown as Env;
const repo = 'published-continuation';
const call = approvedLedger(bindings, repo);
const agents = [{ provider: 'mimo', model: 'mimo-v2.6-flash', strategy: 'minimal' }];
const policy = {
  version: 'continuation-v1',
  suite: 'commands-v1',
  environment: 'linux-node24-rust1.94-v1',
  required_checks: ['build'],
  build: { checks: [{ name: 'build', argv: ['node', '--check', 'app.js'], timeout_seconds: 30 }] },
};
// What the start route approves: a sandbox run on the published commit.
async function start(id: string, extra: Json = {}) {
  const { published_commit: commit } = await call({ op: 'repository_status' });
  return call({ op: 'start_run', id, intent: 'Improve the published website', agents,
    ...sandboxStart({ repository: `platform/${repo}`, commit, tree: 'e'.repeat(40) }), ...extra });
}
afterEach(async () => {
  await reset();
});

// Synthetic sandbox, evaluation and publication observations test the real DO without inference.
async function release(run: string, commit: string) {
  const agent = await call({ op: 'claim', job_id: `job:${run}:agent-1` });
  const { base } = (await call({ op: 'snapshot' })).runs.find((r: Json) => r.id === run);
  const candidate = `candidate-${run}`;
  await finishSandbox(bindings, repo, agent, base, { commit, tree: 'f'.repeat(40) },
    { id: candidate, paths: ['app.js'], summary: 'Published fixture' });
  const evaluator = await call({ op: 'claim', job_id: `evaluate:${candidate}` });
  await call({
    op: 'verify_finish',
    job_id: evaluator.id,
    epoch: evaluator.epoch,
    report: {
      suite: policy.suite,
      environment: policy.environment,
      setup: [],
      commands: [{ name: 'build', output: { exit: 0 } }],
    },
    evidence: (await object(bindings, 'Synthetic evaluator observations')).digest,
  });
  const { repository } = await call({ op: 'snapshot' });
  const decision = await call({
    op: 'accept',
    request_id: `release-${run}`,
    candidate,
    expected_commit: repository.head_commit,
    expected_version: repository.version,
    rationale: 'Synthetic owner selection',
  });
  // The owner lands on the platform; the trusted adapter records the platform readback.
  await call({ op: 'publication_readback', decision_id: decision.id, observed_commit: commit });
  return decision.id as string;
}
async function initialize() {
  await call({
    op: 'init',
    id: repo,
    name: 'Published website',
    remote: { namespace: 'platform', name: repo, branch: 'main' },
    commit: 'a'.repeat(40),
    policy,
  });
  await start('original');
  return release('original', 'b'.repeat(40));
}
async function unchangedFailure(input: Json, code: string) {
  const before = await call({ op: 'snapshot' });
  const outbox = await call({ op: 'outbox' });
  await expect(call(input)).rejects.toMatchObject({ code });
  expect(await call({ op: 'snapshot' })).toEqual(before);
  expect(await call({ op: 'outbox' })).toEqual(outbox);
}

it('requires the continuation capability before a newer Worker sends the field to an older ledger', () => {
  const old = {
    capabilities: { artifact_reads: 2, agent_limits: { min_root_agents: 1, max_root_agents: 6 } },
  };
  const request = { agents, continuation_of: 'decision:release' };
  expect(() => checkLedger(old, request)).toThrow('updating');
  expect(() => checkLedger(old, { agents })).not.toThrow();
  expect(() =>
    checkLedger({ capabilities: { ...old.capabilities, published_continuation: 1 } }, request),
  ).not.toThrow();
});

it('continues the published decision despite newer failed and unpublished runs, preserving graph and context across eviction', async () => {
  const published = await initialize();
  await call({
    op: 'context_publish',
    record: {
      id: 'context:brand',
      kind: 'constraint',
      statement: 'Keep the published brand colors',
      purpose: 'Preserve release context',
      intent_id: 'intent:original',
      links: [],
    },
  });
  await start('newer-failed');
  const failed = await call({ op: 'claim', job_id: 'job:newer-failed:agent-1' });
  await call({
    op: 'fail',
    job_id: failed.id,
    epoch: failed.epoch,
    retryable: false,
    error: 'Synthetic failure',
  });
  await start('newer-unpublished');
  const before = await call({ op: 'snapshot' });
  const update = await start('update', {
    continuation_of: published,
    context: ['context:brand'],
  });
  expect(update).toMatchObject({
    continuation_of: published,
    base: { commit: 'b'.repeat(40) },
    base_version: 1,
  });
  await evictDurableObject(bindings.REPOSITORIES.get(bindings.REPOSITORIES.idFromName(repo)));
  const snapshot = await call({ op: 'snapshot' });
  expect(snapshot.capabilities.published_continuation).toBe(1);
  expect(snapshot.edges).toContainEqual(
    expect.objectContaining({ source: published, target: 'update', relation: 'continues' }),
  );
  for (const historical of before.runs) expect(snapshot.runs).toContainEqual(historical);
  expect(update.context_records[0]).toMatchObject({
    id: 'context:brand',
    label: 'Keep the published brand colors',
  });
});

it('fences stale, missing and mixed continuation references without graph, events or dispatch side effects', async () => {
  const original = await initialize();
  await start('next', { continuation_of: original });
  const latest = await release('next', 'c'.repeat(40));
  await unchangedFailure(
    { op: 'start_run', id: 'stale', intent: 'Old form', agents, continuation_of: original },
    'HEAD_MOVED',
  );
  await unchangedFailure(
    {
      op: 'start_run',
      id: 'missing',
      intent: 'Missing release',
      agents,
      continuation_of: 'decision:missing',
    },
    'NOT_FOUND',
  );
  await unchangedFailure(
    {
      op: 'start_run',
      id: 'mixed',
      intent: 'Ambiguous lineage',
      agents,
      continuation_of: latest,
      restart_of: 'missing-run',
    },
    'INVALID_INPUT',
  );
  expect((await start('current', { continuation_of: latest })).base.commit).toBe('c'.repeat(40));
});
