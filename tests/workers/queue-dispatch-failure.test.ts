import { env } from 'cloudflare:workers';
import { reset } from 'cloudflare:test';
import { afterEach, expect, it } from 'vitest';
import { ledger } from '../../cloudflare/worker/storage';
import type { Env, Envelope } from '../../cloudflare/worker/types';
import { reviewerFixture } from './reviewer-fixture';
import { reviewerPolicy } from '../../cloudflare/worker/reviewer-policy';

const bindings = env as unknown as Env;
afterEach(reset);

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
  });
  await ledger(bindings, fixture.repo, {
    op: 'start_run',
    id: 'ack-loss-run',
    intent: 'Preserve an active execution after queue acknowledgment loss',
    agents: [{ provider: 'codex', model: 'gpt-5.6-luna', strategy: 'Synthetic queue regression' }],
  });
  const jobId = 'job:ack-loss-run:agent-1';

  const queue = bindings.SELF as unknown as {
    dispatchOneForTest(
      envelope: Envelope,
      loseAck: boolean,
    ): Promise<{ acked: boolean; retries: number[]; launchRequested: boolean }>;
  };
  const outcome = await queue.dispatchOneForTest(
    { v: 1, kind: 'agent', repo_id: fixture.repo, job_id: jobId },
    true,
  );

  expect(outcome).toEqual({ acked: false, retries: [20], launchRequested: true });
  const status = await ledger(bindings, fixture.repo, { op: 'job_status', id: jobId });
  expect(status).toMatchObject({ status: 'running', epoch: 1, attempt: 1, progress: null });
  const redelivery = await queue.dispatchOneForTest(
    { v: 1, kind: 'agent', repo_id: fixture.repo, job_id: jobId },
    false,
  );
  expect(redelivery).toEqual({ acked: true, retries: [], launchRequested: false });
  expect(await ledger(bindings, fixture.repo, { op: 'job_status', id: jobId }))
    .toMatchObject({ status: 'running', epoch: 1, attempt: 1 });
});
