// Planner output/captures are synthetic; transport, fences and activation use the real Rust DO.
import { env } from 'cloudflare:workers';
import { evictDurableObject, reset } from 'cloudflare:test';
import { afterEach, expect, it } from 'vitest';
import { brokerHandler } from '../../cloudflare/worker/broker';
import { hostedMcp } from '../../cloudflare/worker/hosted-mcp';
import { ledger } from '../../cloudflare/worker/storage';
import type { Env, Json, Scope } from '../../cloudflare/worker/types';

const bindings = env as unknown as Env;
const repo = 'offline-auto-team';
const base = 'a'.repeat(40);
afterEach(reset);
const plan = { version: 1, contract: 'Keep bilingual bike UI and SQLite API source complementary; backend deployment is separate.',
  integrator_agent: 1, integration_paths: ['frontend/', 'README.md'], tasks: [
    { id: 'ui', title: 'Bilingual bike club UI', instructions: 'Implement English and Spanish UI.', agent: 0, depends_on: [], write_paths: ['frontend/'] },
    { id: 'api', title: 'SQLite club API', instructions: 'Implement API source and database migrations.', agent: 1, depends_on: [], write_paths: ['backend/'] },
  ] };
function scope(job: Json): Scope {
  return { repo_id: repo, job, supervisor: 'private-test-token', model_calls: 0, created_at: Date.now() };
}
async function setup() {
  await ledger(bindings, repo, { op: 'init', id: repo, name: 'Automatic team fixture',
    remote: { namespace: 'yoneda-test', name: repo }, commit: base,
    policy: { version: 'auto-v1', suite: 'commands-v1', environment: 'linux-node24-rust1.94-v1',
      required_checks: ['build'], build: { setup: [], checks: [{ name: 'build', argv: ['node', '--version'], timeout_seconds: 10 }] } },
  });
  await ledger(bindings, repo, { op: 'start_run', id: 'auto', mode: 'collaborate', intent: 'A bilingual bike club with SQLite API',
    agents: [{ provider: 'mimo', model: 'mimo-v2.6-flash', strategy: 'Team participant' }, { provider: 'zai', model: 'glm-5.3-flash', strategy: 'Team participant' }],
  });
  return ledger(bindings, repo, { op: 'claim', job_id: 'job:auto:planner' });
}

it('derives planner identity, persists an assertion across eviction, and activates only after unchanged-source completion', async () => {
  const job = await setup();
  let snapshot = await ledger(bindings, repo, { op: 'snapshot' });
  expect(snapshot.capabilities.team_planning).toBe(1);
  expect(snapshot.runs[0].status).toBe('planning');
  expect(snapshot.executions).toHaveLength(1);
  expect(snapshot.team_tasks).toEqual([]);
  const proposal = await (await hostedMcp(bindings, scope(job), { name: 'team_plan_propose', arguments: { plan, job_id: 'forged', epoch: 99 } })).json<Json>();
  expect(proposal.author).toBe('auto:planner');
  expect(proposal.data.epoch).toBe(job.epoch);
  expect(proposal.data.authority).toBe('assertion');
  const duplicate = await (await hostedMcp(bindings, scope(job), { name: 'team_plan_propose', arguments: { plan } })).json<Json>();
  expect(duplicate.id).toBe(proposal.id);
  const revisedPlan = { ...plan, contract: `${plan.contract} Preserve club membership validation at the API boundary.` };
  await expect(hostedMcp(bindings, scope(job), { name: 'team_plan_propose', arguments: { plan: revisedPlan } })).rejects.toThrow('expected_proposal');
  const revised = await (await hostedMcp(bindings, scope(job), { name: 'team_plan_propose', arguments: { plan: revisedPlan, expected_proposal: proposal.id } })).json<Json>();
  expect(revised.id).not.toBe(proposal.id);
  expect(revised.data.draft_revision).toBe(2);
  const oldReplay = await (await hostedMcp(bindings, scope(job), { name: 'team_plan_propose', arguments: { plan } })).json<Json>();
  expect(oldReplay.id).toBe(proposal.id);
  snapshot = await ledger(bindings, repo, { op: 'snapshot' });
  expect(snapshot.runs[0].team_plan_proposal).toBe(revised.id);
  await hostedMcp(bindings, scope(job), { name: 'execution_complete', arguments: { summary: 'Planned complementary work' } });
  expect((await ledger(bindings, repo, { op: 'snapshot' })).team_tasks).toEqual([]);
  await expect(ledger(bindings, repo, { op: 'finish', job_id: job.id, epoch: job.epoch, result: { planning: true, source_unchanged: true, workspace: 'b'.repeat(64) } })).rejects.toThrow('read-only');
  await evictDurableObject(bindings.REPOSITORIES.get(bindings.REPOSITORIES.idFromName(repo)));
  await ledger(bindings, repo, { op: 'finish', job_id: job.id, epoch: job.epoch, result: { planning: true, source_unchanged: true, transcript: 'c'.repeat(64) } });
  snapshot = await ledger(bindings, repo, { op: 'snapshot' });
  expect(snapshot.runs[0].status).toBe('exploring');
  expect(snapshot.runs[0].team_plan).toEqual(revisedPlan);
  expect(snapshot.runs[0].agents).toHaveLength(2);
  expect(snapshot.team_tasks.map((t: Json) => t.task_id)).toEqual(['api', 'integrate', 'ui']);
  expect(snapshot.team_tasks.find((t: Json) => t.task_id === 'integrate').status).toBe('blocked');
  expect(snapshot.candidates).toEqual([]);
  await expect(hostedMcp(bindings, scope(job), { name: 'team_plan_propose', arguments: { plan } })).rejects.toThrow();
});

it('cancellation fences the planning proposal without dispatching worker tasks', async () => {
  const job = await setup();
  await ledger(bindings, repo, { op: 'cancel_run', run_id: 'auto' });
  await expect(hostedMcp(bindings, scope(job), { name: 'team_plan_propose', arguments: { plan } })).rejects.toThrow();
  expect((await ledger(bindings, repo, { op: 'snapshot' })).team_tasks).toEqual([]);
});

it('returns typed validation feedback through the container broker instead of rejecting its outbound promise', async () => {
  const job = await setup();
  // Container identity is synthetic; the command and validation use the real Rust DO.
  const scopedBindings = { ...bindings, EXECUTIONS: {
    idFromString: (id: string) => id,
    get: () => ({ scope: async () => scope(job) }),
  } } as unknown as Env;
  const request = new Request('http://yoneda.internal/mcp', { method: 'POST', body: JSON.stringify({ name: 'team_plan_propose', arguments: { plan: { ...plan, tasks: [] } } }) });
  const result = await brokerHandler(request, scopedBindings, { containerId: 'synthetic-container' } as Parameters<typeof brokerHandler>[2]);
  expect(result.status).toBe(409);
  const body = await result.json<Json>();
  expect(body.error.code).toBe('INVALID_INPUT');
  expect(body.error.message).toContain('task');
  expect((await ledger(bindings, repo, { op: 'snapshot' })).team_tasks).toEqual([]);
});
