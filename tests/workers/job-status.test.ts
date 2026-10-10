import { env } from 'cloudflare:workers';
import { afterEach, expect, it } from 'vitest';
import { reset } from 'cloudflare:test';
import { ledger } from '../../cloudflare/worker/storage';
import type { Env, Json } from '../../cloudflare/worker/types';
import { api, reviewerFixture, signup } from './reviewer-fixture';
import { reviewerPolicy } from '../../cloudflare/worker/reviewer-policy';

const bindings = env as unknown as Env;
afterEach(reset);

it('reads the real frozen capture payload projection by public id for its owner only', async () => {
  const owner = await reviewerFixture('job_status_owner');
  const otherCookie = await signup('job_status_other');
  await ledger(bindings, owner.repo, {
    op: 'init',
    id: owner.repo,
    name: 'Job status diagnostic fixture',
    workspace: owner.owner,
    remote: { namespace: 'yoneda-test', name: owner.repo },
    commit: 'a'.repeat(40),
    policy: reviewerPolicy,
    workspace_transport: 'git-native-v1',
  });
  await ledger(bindings, owner.repo, {
    op: 'start_run',
    id: 'job-status-run',
    intent: 'Inspect bounded capture diagnostics',
    agents: [{ provider: 'codex', model: 'gpt-5.6-luna', strategy: 'Synthetic capture fixture' }],
  });
  const agent = await ledger(bindings, owner.repo, {
    op: 'claim', job_id: 'job:job-status-run:agent-1',
    models: { codex: 'gpt-5.6-luna', claude: 'claude-sonnet-5-5' },
  });
  await ledger(bindings, owner.repo, {
    op: 'finish', job_id: agent.id, epoch: agent.epoch,
    result: {
      git_verified: true,
      fork_revision: { repository: 'yoneda-test/attempt-fork', commit: 'b'.repeat(40) },
    },
  });
  const capture = await ledger(bindings, owner.repo, { op: 'claim', job_id: 'capture:job-status-run:agent-1' });

  const response = await api(
    owner.scoped,
    `/api/repos/${owner.repo}/job_status?id=${encodeURIComponent(capture.id)}&job_id=forged-job`,
    owner.cookie,
  );
  expect(response.status).toBe(200);
  const status = await response.json<Json>();
  expect(status).toMatchObject({
    id: capture.id,
    kind: 'capture',
    status: 'running',
    epoch: capture.epoch,
    workspace_transport: 'git-native-v1',
    source_revision: { repository: 'yoneda-test/attempt-fork', commit: 'b'.repeat(40) },
    execution: {
      id: 'job-status-run:agent-1',
      base: { repository: `yoneda-test/${owner.repo}`, commit: 'a'.repeat(40) },
    },
  });
  expect(status).not.toHaveProperty('payload');
  expect(status).not.toHaveProperty('model_budget');

  const missingId = await api(
    owner.scoped,
    `/api/repos/${owner.repo}/job_status?job_id=${encodeURIComponent(capture.id)}`,
    owner.cookie,
  );
  expect(missingId.status).toBe(400);
  expect(await missingId.json()).toMatchObject({ error: { code: 'INVALID_INPUT' } });

  const denied = await api(
    bindings,
    `/api/repos/${owner.repo}/job_status?id=${encodeURIComponent(capture.id)}`,
    otherCookie,
  );
  expect(denied.status).toBe(403);
});
