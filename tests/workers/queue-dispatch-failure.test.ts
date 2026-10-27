import { env } from 'cloudflare:workers';
import { reset } from 'cloudflare:test';
import { afterEach, expect, it } from 'vitest';
import { ledger } from '../../cloudflare/worker/storage';
import type { Env, Envelope } from '../../cloudflare/worker/types';
import { readyReviewer } from './reviewer-fixture';
import { approvedLedger, sandboxStart } from './source-kit';

const bindings = env as unknown as Env;
afterEach(reset);

it('does not fail a running job when its sandbox starts but queue acknowledgment is lost', async () => {
  // The provisioned reviewer project's ledger names its platform repository and real head.
  const fixture = await readyReviewer('queue_launch_ack_loss');
  await approvedLedger(bindings, fixture.repo)({
    op: 'start_run',
    id: 'ack-loss-run',
    intent: 'Preserve an active execution after queue acknowledgment loss',
    // What the start route approves: a sandbox run over the project's platform head.
    ...sandboxStart({ repository: `platform/${fixture.repo}`, commit: fixture.head, tree: fixture.tree }),
    agents: [{ provider: 'codex', model: 'gpt-5.6-luna', strategy: 'Synthetic queue regression' }],
  });
  const jobId = 'job:ack-loss-run:agent-1';

  const queue = bindings.SELF as unknown as {
    dispatchOneForTest(
      envelope: Envelope,
      loseAck: boolean,
    ): Promise<{ acked: boolean; retries: number[] }>;
  };
  const outcome = await queue.dispatchOneForTest(
    { v: 1, kind: 'agent', repo_id: fixture.repo, job_id: jobId },
    true,
  );

  expect(outcome).toEqual({ acked: false, retries: [20] });
  const status = await ledger(bindings, fixture.repo, { op: 'job_status', id: jobId });
  // A sandbox claim holds one lease for the whole attempt (`attempt` 2: never re-dispatched).
  expect(status).toMatchObject({ status: 'running', epoch: 1, attempt: 2, progress: null });
  const redelivery = await queue.dispatchOneForTest(
    { v: 1, kind: 'agent', repo_id: fixture.repo, job_id: jobId },
    false,
  );
  expect(redelivery).toEqual({ acked: true, retries: [] });
  expect(await ledger(bindings, fixture.repo, { op: 'job_status', id: jobId }))
    .toMatchObject({ status: 'running', epoch: 1 });
});
