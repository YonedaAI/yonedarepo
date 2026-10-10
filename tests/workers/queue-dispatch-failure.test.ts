import { env } from 'cloudflare:workers';
import { reset, runInDurableObject } from 'cloudflare:test';
import { afterEach, expect, it } from 'vitest';
import { ledger } from '../../cloudflare/worker/storage';
import type { Env, Envelope } from '../../cloudflare/worker/types';
import { api, reviewerFixture } from './reviewer-fixture';
import { reviewerPolicy } from '../../cloudflare/worker/reviewer-policy';

const bindings = env as unknown as Env;
afterEach(reset);

it('durably fails a capture with a missing frozen Git source instead of consuming its lease', async () => {
  const fixture = await reviewerFixture('queue_dispatch_failure');
  await ledger(bindings, fixture.repo, {
    op: 'init',
    id: fixture.repo,
    name: 'Queue dispatch failure fixture',
    workspace: fixture.owner,
    remote: { namespace: 'yoneda-test', name: fixture.repo },
    commit: 'a'.repeat(40),
    policy: reviewerPolicy,
    workspace_transport: 'git-native-v1',
  });
  await ledger(bindings, fixture.repo, {
    op: 'start_run',
    id: 'dispatch-run',
    intent: 'Exercise pre-launch failure disposition',
    agents: [{ provider: 'codex', model: 'gpt-5.6-luna', strategy: 'Synthetic queue regression' }],
  });
  const agent = await ledger(bindings, fixture.repo, {
    op: 'claim',
    job_id: 'job:dispatch-run:agent-1',
    models: { codex: 'gpt-5.6-luna', claude: 'claude-sonnet-5-5' },
  });
  await ledger(bindings, fixture.repo, {
    op: 'finish',
    job_id: agent.id,
    epoch: agent.epoch,
    result: {
      git_verified: true,
      fork_revision: { repository: 'yoneda-test/attempt-fork', commit: 'b'.repeat(40) },
    },
  });
  const captureId = 'capture:dispatch-run:agent-1';
  const frozen = await ledger(bindings, fixture.repo, { op: 'job_status', id: captureId });
  expect(frozen.workspace_transport).toBe('git-native-v1');
  expect(frozen.source_revision).toMatchObject({ repository: 'yoneda-test/attempt-fork' });

  // Simulate the confirmed production payload defect without weakening the trusted producer.
  const repository = bindings.REPOSITORIES.get(bindings.REPOSITORIES.idFromName(fixture.repo));
  await runInDurableObject(repository, (_instance, state) => {
    state.storage.sql.exec(
      "UPDATE jobs SET payload=json_remove(payload,'$.payload.source_revision') WHERE id=?",
      captureId,
    );
  });
  const queue = bindings.SELF as unknown as {
    dispatchOneForTest(envelope: Envelope): Promise<{ acked: boolean; retries: number[] }>;
  };
  const outcome = await queue.dispatchOneForTest({
    v: 1,
    kind: 'capture',
    repo_id: fixture.repo,
    job_id: captureId,
  });

  expect(outcome).toEqual({ acked: true, retries: [], launchRequested: false });
  const status = await ledger(bindings, fixture.repo, { op: 'job_status', id: captureId });
  expect(status).toMatchObject({ status: 'failed', epoch: 1, attempt: 1, progress: null });
  expect(status.error).toContain('INVALID_CAPTURE');

  const ownerRead = await api(
    fixture.scoped,
    `/api/repos/${fixture.repo}/job_status?id=${encodeURIComponent(captureId)}`,
    fixture.cookie,
  );
  expect(ownerRead.status).toBe(200);
  expect(await ownerRead.json()).toMatchObject({ status: 'failed', error: expect.stringContaining('INVALID_CAPTURE') });
});

it('does not fail a running job when launch succeeds but queue acknowledgment is lost', async () => {
  const fixture = await reviewerFixture('queue_launch_ack_loss');
  await ledger(bindings, fixture.repo, {
    op: 'init',
    id: fixture.repo,
    name: 'Queue launch acknowledgment fixture',
    workspace: fixture.owner,
    remote: { namespace: 'yoneda-test', name: fixture.repo },
    commit: 'c'.repeat(40),
    policy: reviewerPolicy,
    workspace_transport: 'git-native-v1',
  });
  await ledger(bindings, fixture.repo, {
    op: 'start_run',
    id: 'ack-loss-run',
    intent: 'Preserve an active execution after queue acknowledgment loss',
    agents: [{ provider: 'codex', model: 'gpt-5.6-luna', strategy: 'Synthetic queue regression' }],
  });
  const agent = await ledger(bindings, fixture.repo, {
    op: 'claim',
    job_id: 'job:ack-loss-run:agent-1',
    models: { codex: 'gpt-5.6-luna', claude: 'claude-sonnet-5-5' },
  });
  await ledger(bindings, fixture.repo, {
    op: 'finish',
    job_id: agent.id,
    epoch: agent.epoch,
    result: {
      git_verified: true,
      fork_revision: { repository: 'yoneda-test/attempt-fork', commit: 'd'.repeat(40) },
    },
  });
  const captureId = 'capture:ack-loss-run:agent-1';
  const frozen = await ledger(bindings, fixture.repo, { op: 'job_status', id: captureId });
  expect(frozen.workspace_transport).toBe('git-native-v1');
  expect(frozen.source_revision).toMatchObject({ repository: 'yoneda-test/attempt-fork' });

  const queue = bindings.SELF as unknown as {
    dispatchOneForTest(
      envelope: Envelope,
      loseAck: boolean,
    ): Promise<{ acked: boolean; retries: number[]; launchRequested: boolean }>;
  };
  const outcome = await queue.dispatchOneForTest(
    { v: 1, kind: 'capture', repo_id: fixture.repo, job_id: captureId },
    true,
  );

  expect(outcome).toEqual({ acked: false, retries: [20], launchRequested: true });
  const status = await ledger(bindings, fixture.repo, { op: 'job_status', id: captureId });
  expect(status).toMatchObject({ status: 'running', epoch: 1, attempt: 1, progress: null });
  const redelivery = await queue.dispatchOneForTest(
    { v: 1, kind: 'capture', repo_id: fixture.repo, job_id: captureId },
    false,
  );
  expect(redelivery).toEqual({ acked: true, retries: [], launchRequested: false });
  expect(await ledger(bindings, fixture.repo, { op: 'job_status', id: captureId }))
    .toMatchObject({ status: 'running', epoch: 1, attempt: 1 });
});
