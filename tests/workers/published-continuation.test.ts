import { env } from 'cloudflare:workers';
import { evictDurableObject, reset } from 'cloudflare:test';
import { afterEach, expect, it } from 'vitest';
import { checkLedger } from '../../cloudflare/worker/runtime';
import { ledger, object, readObject } from '../../cloudflare/worker/storage';
import type { Env, Json } from '../../cloudflare/worker/types';

const bindings = env as unknown as Env;
const repo = 'published-continuation';
const call = (input: Json) => ledger(bindings, repo, input);
const agents = [{ provider: 'mimo', model: 'mimo-v2.6-flash', strategy: 'minimal' }];
const policy = {
  version: 'continuation-v1',
  suite: 'commands-v1',
  environment: 'linux-node24-rust1.94-v1',
  required_checks: ['build'],
  build: { checks: [{ name: 'build', argv: ['node', '--check', 'app.js'], timeout_seconds: 30 }] },
};
const start = (id: string, extra: Json = {}) =>
  call({ op: 'start_run', id, intent: 'Improve the published website', agents, ...extra });
afterEach(async () => {
  await reset();
});

// Synthetic capture, evaluation and publication observations test the real DO without inference.
async function release(run: string, commit: string) {
  const execution = `${run}:agent-1`;
  const agent = await call({ op: 'claim', job_id: `job:${execution}` });
  const design = await object(bindings, `Keep the published design from ${run}`);
  await call({
    op: 'publish_artifact',
    job_id: agent.id,
    epoch: agent.epoch,
    id: `artifact:${run}`,
    digest: design.digest,
    label: 'Published design notes',
    kind: 'design',
  });
  const workspace = await object(
    bindings,
    JSON.stringify({ files: { 'app.js': { content: 'console.log("fixture");' } } }),
  );
  await call({
    op: 'finish',
    job_id: agent.id,
    epoch: agent.epoch,
    result: { workspace: workspace.digest },
  });
  const capture = await call({ op: 'claim', job_id: `capture:${execution}` });
  const candidate = `candidate-${run}`;
  const revision = { repository: 'yoneda-test/fixture-fork', commit };
  await call({
    op: 'finish',
    job_id: capture.id,
    epoch: capture.epoch,
    result: {
      id: candidate,
      revision,
      tree: 'f'.repeat(40),
      paths: ['app.js'],
      diff: 'fixture diff',
      summary: 'Published fixture',
    },
  });
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
  const publisher = await call({ op: 'claim', job_id: `publish:${decision.id}` });
  await call({ op: 'finish', job_id: publisher.id, epoch: publisher.epoch, result: { commit } });
  return decision.id as string;
}
async function initialize() {
  await call({
    op: 'init',
    id: repo,
    name: 'Published website',
    remote: { namespace: 'yoneda-test', name: repo },
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
    context: ['context:brand', 'artifact:original'],
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
  const job = await call({ op: 'claim', job_id: 'job:update:agent-1' });
  const delivered = await call({ op: 'context', job_id: job.id, epoch: job.epoch });
  expect(delivered.run.continuation_of).toBe(published);
  expect(delivered.run.context_records).toEqual(update.context_records);
  expect(delivered.run.context_records[0]).toMatchObject({
    id: 'context:brand',
    label: 'Keep the published brand colors',
  });
  expect(delivered.run.context_records[1]).toMatchObject({
    id: 'artifact:original',
    kind: 'context',
  });
  const artifact = await call({
    op: 'get_artifact',
    job_id: job.id,
    epoch: job.epoch,
    id: 'artifact:original',
  });
  expect(await readObject(bindings, artifact.digest)).toBe(
    'Keep the published design from original',
  );
  await expect(
    call({ op: 'get_artifact', job_id: job.id, epoch: job.epoch, id: 'artifact:unselected' }),
  ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  expect((await call({ op: 'snapshot' })).edges).toContainEqual(
    expect.objectContaining({
      source: 'artifact:original',
      target: job.payload.execution.id,
      relation: 'retrieved_by',
    }),
  );
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
