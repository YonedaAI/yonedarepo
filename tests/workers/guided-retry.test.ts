// Step retry through the real Rust/Wasm repository DO. No provider, container or source work runs;
// the failed attempt is an owner cancellation, which is a real terminal ledger transition.
import { env } from 'cloudflare:workers';
import { reset } from 'cloudflare:test';
import { afterEach, expect, it } from 'vitest';
import { guidedPolicy } from '../../cloudflare/worker/guided-profile';
import { sourceFingerprint } from '../../cloudflare/worker/source-crypto';
import { ledger } from '../../cloudflare/worker/storage';
import type { Env, Json } from '../../cloudflare/worker/types';
import { providerRegistry } from '../../shared/provider-registry';

const bindings = env as unknown as Env;
const repo = 'guided-retry';
const owner = 'guided_retry_owner';
const session = 'guide-session:retry';
const base = 'a'.repeat(40);
afterEach(reset);
const call = (command: Json) => ledger(bindings, repo, command);
const read = () => call({ op: 'guided_session', session_id: session, _workspace: owner });

function prepared(): Json {
  const pricing = (
    providerRegistry
      .find((provider) => provider.id === 'zai')
      ?.models.find((model) => model.id === 'glm-5.3-flash') as Json
  ).conservative_pricing;
  return {
    intent: 'Implement the guided task board with stable IDs',
    agents: [
      { provider: 'zai', model: 'glm-5.3-flash', strategy: 'Core' },
      { provider: 'zai', model: 'glm-5.3-flash', strategy: 'Interface' },
    ],
    model_budgets: [{ provider: 'zai', model: 'glm-5.3-flash', max_requests: 16,
      max_output_tokens: 4096, max_execution_ms: 600000, spend_limit_microusd: 1000000, pricing }],
    team: { version: 1, contract: 'Task records have stable IDs', integrator_agent: 1,
      integration_paths: ['public/'], tasks: [
        { id: 'core', title: 'Core', instructions: 'Implement', agent: 0, depends_on: [], write_paths: ['public/tasks.mjs'] },
        { id: 'ui', title: 'UI', instructions: 'Implement', agent: 1, depends_on: [], write_paths: ['public/app.mjs'] },
      ] },
  };
}
async function start(requestId: string, retry?: true) {
  const view = await read();
  return call({ op: 'start_guided_step', _workspace: owner, session_id: session,
    profile_id: 'task-board-v1', step_id: 'build', request_id: requestId,
    expected_commit: view.working_revision.commit, expected_version: view.working_version,
    ...(retry ? { retry } : {}), _guided_runs: [prepared()] });
}

it('a cancelled build attempt is retried once with suffixed runs and replays without allocation', async () => {
  const policy = guidedPolicy('d'.repeat(64));
  await call({ op: 'init', id: repo, name: 'Offline guided retry fixture', workspace: owner,
    remote: { namespace: 'yoneda-test', name: repo, branch: 'main' }, commit: base, tree: 'b'.repeat(40), policy,
    _guided_project: { profile_id: 'task-board-v1', version: 1, policy_digest: await sourceFingerprint(policy),
      test_bundle_digest: 'd'.repeat(64),
      starter: { repository: 'yoneda-test/starter', branch: 'main', commit: base, tree: 'b'.repeat(40) } } });
  const first = (await start('start-build')).steps[0].run_ids[0] as string;
  await expect(start('early-retry', true)).rejects.toMatchObject({ code: 'GUIDED_STEP_NOT_RETRYABLE' });
  await call({ op: 'cancel_run', run_id: first, _workspace: owner });
  expect((await read()).steps[0]).toMatchObject({ status: 'needs_attention', attempt: 1 });
  const retried = await start('retry-build', true);
  expect(retried.steps[0]).toMatchObject({ status: 'running', attempt: 2,
    run_ids: [`${first}-r2`], previous_run_ids: [first] });
  const snapshot = await call({ op: 'snapshot' });
  expect(await start('retry-build', true)).toEqual(retried);
  expect((await call({ op: 'snapshot' })).jobs).toEqual(snapshot.jobs);
});
