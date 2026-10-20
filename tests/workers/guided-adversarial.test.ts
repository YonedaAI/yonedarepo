// Source/check observations are synthetic. All evidence, phase bindings, leases,
// capture transitions and two-run transactions use real Rust/Wasm DO commands.
import { env } from 'cloudflare:workers';
import { evictDurableObject, reset, runInDurableObject } from 'cloudflare:test';
import { afterEach, expect, it } from 'vitest';
import { guidedPolicy } from '../../cloudflare/worker/guided-profile';
import { hostedMcp } from '../../cloudflare/worker/hosted-mcp';
import { fetchRequest } from '../../cloudflare/worker/routes';
import { sourceFingerprint } from '../../cloudflare/worker/source-crypto';
import { ledger } from '../../cloudflare/worker/storage';
import type { Env, Json, Scope } from '../../cloudflare/worker/types';
import { reviewerSignup, signup } from './reviewer-fixture';
import { providerRegistry } from '../../shared/provider-registry';
import { approvedLedger, finishSealed, withLineage } from './source-kit';

const bindings = env as unknown as Env;
const repo = 'guided-adversarial';
const owner = 'guided_adversary';
const session = 'guide-session:adversarial';
const base = 'a'.repeat(40);
const bundle = 'd'.repeat(64);
afterEach(reset);
const call = approvedLedger(bindings, repo);
const read = () => call({ op: 'guided_session', session_id: session, _workspace: owner });
const scope = (job: Json): Scope => ({ repo_id: repo, job, supervisor: 'synthetic-attempt', model_calls: 0, created_at: Date.now() });

function prepared(): Json {
  const pricing = (providerRegistry.find(provider => provider.id === 'zai')?.models
    .find(model => model.id === 'glm-5.3-flash') as Json).conservative_pricing;
  return { intent: 'Implement the guided task board with stable IDs',
    agents: [{ provider: 'zai', model: 'glm-5.3-flash', strategy: 'Core' },
      { provider: 'zai', model: 'glm-5.3-flash', strategy: 'Interface' }],
    model_budgets: [{ provider: 'zai', model: 'glm-5.3-flash', max_requests: 16,
      max_output_tokens: 4096, max_execution_ms: 600000, spend_limit_microusd: 1000000, pricing }],
    autonomy_policy: { version: 1, enabled: true, max_repair_rounds: 2, max_concurrent_agents: 3,
      max_executions: 20, source_scope: 'project', allow_intent_questions: true },
    team: { version: 1, contract: 'Task records have stable IDs', integrator_agent: 1,
      integration_paths: ['public/'], tasks: [
        { id: 'core', title: 'Core', instructions: 'Implement task functions', agent: 0, depends_on: [], write_paths: ['public/tasks.mjs'] },
        { id: 'ui', title: 'UI', instructions: 'Implement task interface', agent: 1, depends_on: [], write_paths: ['public/app.mjs'] },
      ] } };
}
async function fixture(guidedProject = true, reviewer = true) {
  const cookie = reviewer ? await reviewerSignup(owner) : await signup(owner);
  const policy = guidedPolicy(bundle);
  await call({ op: 'init', id: repo, name: 'Offline guided authority fixture', workspace: owner,
    remote: { namespace: 'yoneda-test', name: repo, branch: 'main' }, commit: base, tree: 'b'.repeat(40), policy,
    ...(guidedProject ? { _guided_project: { profile_id: 'task-board-v1', version: 1,
      policy_digest: await sourceFingerprint(policy), test_bundle_digest: bundle,
      starter: { repository: 'yoneda-test/starter', branch: 'main', commit: base, tree: 'b'.repeat(40) } } } : {}),
  });
  return cookie;
}
async function request(step: string, approvals = [prepared()]): Promise<Json> {
  const view = await read();
  return { op: 'start_guided_step', _workspace: owner, session_id: session, profile_id: 'task-board-v1',
    step_id: step, request_id: `request-${step}`, expected_commit: view.working_revision.commit,
    expected_version: view.working_version, _guided_runs: approvals };
}
async function state() {
  const snapshot = await call({ op: 'snapshot' });
  const stub = bindings.REPOSITORIES.get(bindings.REPOSITORIES.idFromName(repo));
  // SQL is observation-only. Fixtures never create or edit authoritative rows.
  return runInDurableObject(stub, async (_instance, storage) => ({
    jobs: storage.storage.sql.exec('SELECT id,payload FROM jobs ORDER BY id').toArray(),
    events: storage.storage.sql.exec('SELECT seq,kind,at,data FROM events ORDER BY seq').toArray(),
    nodes: storage.storage.sql.exec('SELECT id,payload FROM nodes ORDER BY id').toArray(),
    outbox: storage.storage.sql.exec('SELECT id,kind,payload,delivered FROM outbox ORDER BY id').toArray(),
    snapshot,
  }));
}
async function context(job: Json, record: Json) {
  return (await hostedMcp(bindings, scope(job), { name: 'context_publish', arguments: {
    ...record, intent_id: `intent:${job.payload.execution.run_id}`,
  } })).json<Json>();
}
/** Workers and the integrator finish through sealed source; the integration is captured. */
async function captureTeam(rid: string, phase: string, prior?: string) {
  const workers = await Promise.all(['core', 'ui'].map(task => call({ op: 'claim', job_id: `job:${rid}:task:${task}` })));
  for (const job of workers) await call({ op: 'progress', job_id: job.id, epoch: job.epoch, progress: { stage: 'harness_running' } });
  let choice = '';
  if (!prior) {
    const record = await context(workers[0], { kind: 'proposed_decision',
      statement: 'Keep stable IDs so bookmarks retain task identity', purpose: 'Preserve references',
      links: [] });
    expect(record.kind).toBe('proposed_decision');
    expect(record.author).toBe(workers[0].payload.execution.id);
    choice = record.id;
  } else {
    const opened = await hostedMcp(bindings, scope(workers[0]), { name: 'context_get', arguments: { id: prior } });
    expect((await opened.json<Json>()).id).toBe(prior);
    const record = await context(workers[0], { kind: 'proposed_decision',
      statement: 'Preserve stable IDs while extending task links', purpose: 'Continue the earlier design',
      links: [{ relation: 'supports', target: prior }] });
    choice = record.id;
  }
  await new Promise(resolve => setTimeout(resolve, 5));
  for (const job of workers) await call({ op: 'record_transcript', job_id: job.id, epoch: job.epoch, digest: 'e'.repeat(64) });
  for (const [index, job] of workers.entries()) {
    const registration = await finishSealed(bindings, repo, job);
    const capture = await call({ op: 'claim', job_id: `capture:${job.payload.execution.id}` });
    await call({ op: 'finish', job_id: capture.id, epoch: capture.epoch, result: withLineage(registration, {
      id: `specialist:${rid}:${index}`, revision: { repository: `yoneda-test/specialist-${index}`, commit: String(index + 1).repeat(40) },
      tree: 'c'.repeat(40), paths: [index ? 'public/app.mjs' : 'public/tasks.mjs'], summary: 'Synthetic specialist source', diff: 'Synthetic delta',
    }) });
    expect((await call({ op: 'job_status', id: capture.id })).status).toBe('done');
  }
  const integrator = await call({ op: 'claim', job_id: `job:${rid}:task:integrate` });
  const registration = await finishSealed(bindings, repo, integrator);
  const capture = await call({ op: 'claim', job_id: `capture:${rid}:task:integrate` });
  const cid = `integrated:${rid}`;
  await call({ op: 'finish', job_id: capture.id, epoch: capture.epoch, result: withLineage(registration, { id: cid,
    revision: { repository: 'yoneda-test/integrated', commit: (phase === 'parallel'
      ? rid.endsWith('-0') ? 'd' : 'e' : phase === 'build' ? 'b' : 'c').repeat(40) },
    tree: 'c'.repeat(40), paths: ['public/tasks.mjs', 'public/app.mjs'], summary: 'Synthetic integrated source',
    diff: 'Synthetic delta', integration_digest: capture.payload.integration_digest }) });
  return { choice, cid, capture };
}
/** The independent evaluator checks the captured integration for `phase`. */
async function checkTeam(phase: string, { choice, cid, capture }: Awaited<ReturnType<typeof captureTeam>>) {
  const evaluator = await call({ op: 'claim', job_id: `evaluate:${cid}` });
  expect(evaluator.payload.guided).toMatchObject({ session_id: session,
    step_id: phase === 'parallel' ? 'concurrent' : phase, check_phase: phase });
  await call({ op: 'register_site', job_id: evaluator.id, epoch: evaluator.epoch, digest: '1'.repeat(64),
    files: { 'index.html': { content: '<html>Offline synthetic site</html>', executable: false } } });
  await call({ op: 'verify_finish', job_id: evaluator.id, epoch: evaluator.epoch, evidence: '2'.repeat(64), report: {
    environment: evaluator.payload.policy.environment, suite: evaluator.payload.policy.suite,
    guided_check_phase: phase, guided_check_variant: evaluator.payload.guided.variant,
    setup: [], commands: [{ name: 'guided-task-board', output: { exit: 0 } }],
    test_bundle_digest: bundle, protected_changes: [],
  } });
  const candidate = await call({ op: 'candidate_record', id: cid });
  const evaluation = await call({ op: 'evaluation_record', id: candidate.evaluation });
  expect(candidate.status, JSON.stringify(evaluation.checks)).toBe('eligible');
  expect(evaluation.guided, JSON.stringify(evaluation)).toEqual(evaluator.payload.guided);
  expect((await call({ op: 'job_status', id: capture.id })).status).toBe('done');
  return { choice, cid };
}
async function completeTeam(rid: string, phase: string, prior?: string) {
  return checkTeam(phase, await captureTeam(rid, phase, prior));
}

it('native guide reads cannot start work or adopt caller-supplied completion claims', async () => {
  await fixture();
  const before = await state();
  const view = await call({ op: 'guided_session', session_id: session, _workspace: owner,
    step_id: 'concurrent', _guided_runs: [prepared(), prepared()], guided: { check_phase: 'final' },
    steps: [{ id: 'build', status: 'complete', evidence: [{ verified: true }] }] });
  expect(view.steps[0]).toMatchObject({ status: 'ready', run_ids: [] });
  expect(view.steps[2].status).toBe('locked');
  expect(await state()).toEqual(before);
});

it('the actual HTTP guide GET retains the provisioned native marker and rejects public start authority without work', async () => {
  const cookie = await fixture(true);
  const before = await state();
  const query = new URLSearchParams({ session_id: session, step_id: 'concurrent',
    _guided_runs: JSON.stringify([prepared(), prepared()]), guided: JSON.stringify({ check_phase: 'final' }) });
  const get = await fetchRequest(new Request(`https://yoneda/api/repos/${repo}/guided_session?${query}`, { headers: { cookie } }), bindings);
  const view = await get.json<Json>();
  expect(get.status, JSON.stringify(view)).toBe(200);
  expect(view.steps[0]).toMatchObject({ status: 'ready', run_ids: [] });
  expect(view.steps[2].status).toBe('locked');
  expect(await state()).toEqual(before);
  const start = { request_id: 'forged-public-approval', session_id: view.session_id,
    profile_id: 'task-board-v1', step_id: 'build', expected_commit: base, expected_version: 0,
    _guided_runs: [prepared()], guided: { check_phase: 'final' }, policy: { required_checks: [] } };
  const rejected = await fetchRequest(new Request(`https://yoneda/api/repos/${repo}/start_guided_step`, {
    method: 'POST', headers: { cookie }, body: JSON.stringify(start),
  }), bindings);
  expect(rejected.status).toBe(409);
  expect(await rejected.json<Json>()).toMatchObject({ error: { code: 'INVALID_INPUT' } });
  expect(await state()).toEqual(before);
});

it('a non-reviewer owner can read the guide but cannot start operator-funded guided work', async () => {
  const cookie = await fixture(true, false);
  const before = await state();
  const get = await fetchRequest(new Request(`https://yoneda/api/repos/${repo}/guided_session?session_id=${encodeURIComponent(session)}`, { headers: { cookie } }), bindings);
  const view = await get.json<Json>();
  expect(get.status, JSON.stringify(view)).toBe(200);
  expect(view.steps[0]).toMatchObject({ status: 'ready', run_ids: [] });
  const start = { request_id: 'ordinary-build-request', session_id: view.session_id,
    profile_id: 'task-board-v1', step_id: 'build', expected_commit: view.working_revision.commit,
    expected_version: view.working_version };
  const rejected = await fetchRequest(new Request(`https://yoneda/api/repos/${repo}/start_guided_step`, {
    method: 'POST', headers: { cookie }, body: JSON.stringify(start),
  }), bindings);
  expect(rejected.status).toBe(403);
  expect(await rejected.json<Json>()).toMatchObject({ error: { code: 'FORBIDDEN' } });
  // No approval, run, job, event or outbox entry was created.
  expect(await state()).toEqual(before);
  expect((await read()).steps[0]).toMatchObject({ status: 'ready', run_ids: [] });
});

it('real capture, proposed-decision and transcript metadata unlock continuation; replay survives eviction without new work', async () => {
  await fixture();
  const body = await request('build');
  const started = await call(body);
  const rid = started.steps[0].run_ids[0];
  expect((await call({ op: 'run_detail', run_id: rid })).runs[0].guided).toEqual({
    session_id: session, profile_id: 'task-board-v1', version: 1, step_id: 'build', check_phase: 'build',
  });
  await completeTeam(rid, 'build');
  const view = await read();
  expect(view.steps[0].status, JSON.stringify(view.steps[0])).toBe('complete');
  expect(view.steps[1].status).toBe('ready');
  expect(view.steps[0].evidence.find((e: Json) => e.kind === 'design_choice').verified).toBe(true);
  const before = await state();
  await expect(call({ op: 'accept', _workspace: owner, request_id: 'premature-guide-publication',
    candidate: view.steps[0].candidate_id, expected_commit: base, expected_version: 0,
    rationale: 'Cannot present build-only checks as the complete guide' })).rejects.toMatchObject({ code: 'GUIDED_NOT_PUBLISHABLE' });
  expect(await state()).toEqual(before);
  await evictDurableObject(bindings.REPOSITORIES.get(bindings.REPOSITORIES.idFromName(repo)));
  expect((await call(body)).steps[0].run_ids).toEqual([rid]);
  expect(await read()).toEqual(view);
  expect(await state()).toEqual(before);
  await expect(call({ ...body, request_id: 'fresh-stale-request' })).rejects.toThrow('head changed');
});

it('both concurrent starts commit together from one checked base or roll back all first-run allocation', async () => {
  await fixture();
  const build = await call(await request('build'));
  const first = await completeTeam(build.steps[0].run_ids[0], 'build');
  const extension = await call(await request('extend'));
  const extended = await completeTeam(extension.steps[1].run_ids[0], 'extend', first.choice);
  expect((await read()).steps[2].status).toBe('ready');
  const body = await request('concurrent', [prepared(), prepared()]);
  const broken = structuredClone(body);
  broken._guided_runs[1].agents[1].provider = 'invalid-provider';
  const before = await state();
  await expect(call(broken)).rejects.toThrow();
  expect(await state()).toEqual(before);
  const started = await call(body);
  const ids = started.steps[2].run_ids;
  expect(ids).toHaveLength(2);
  const runs = await Promise.all(ids.map(async (rid: string) => (await call({ op: 'run_detail', run_id: rid })).runs[0]));
  expect(runs[0].base).toEqual(runs[1].base);
  expect(runs[0].working_branch_version).toBe(runs[1].working_branch_version);
  expect(runs.map(run => run.guided)).toEqual(['filter', 'sort'].map(variant => ({
    session_id: session, profile_id: 'task-board-v1', version: 1, step_id: 'concurrent', check_phase: 'parallel', variant,
  })));
  const committed = await state();
  await evictDurableObject(bindings.REPOSITORIES.get(bindings.REPOSITORIES.idFromName(repo)));
  expect((await call(body)).steps[2].run_ids).toEqual(ids);
  expect(await state()).toEqual(committed);
  // The second variant registers its sealed source before the first one's check moves the branch.
  const second = await captureTeam(ids[1], 'parallel', extended.choice);
  await completeTeam(ids[0], 'parallel', extended.choice);
  const stale = await checkTeam('parallel', second);
  const candidate = await call({ op: 'candidate_record', id: stale.cid });
  expect(candidate.working_branch_state).toBe('stale');
  const recovered = (await call({ op: 'run_detail', run_id: ids[1] })).runs[0];
  expect(recovered.status).toBe('coordinating');
  expect(recovered.coordinator_execution_id).toBeTruthy();
  const coordinatorId = `job:${recovered.coordinator_execution_id}`;
  const durable = await state();
  // The test entrypoint withholds dispatch; the public outbox page is capped at
  // 50 older projection entries. Observe the actual persisted queue intent.
  expect(durable.outbox.some((entry: Json) => entry.kind === 'agent'
    && JSON.parse(String(entry.payload)).job_id === coordinatorId && entry.delivered === 0)).toBe(true);
  const saved = durable.jobs.find((row: Json) => row.id === coordinatorId);
  expect(saved).toBeDefined();
  const coordinator = JSON.parse(String(saved?.payload));
  expect(coordinator.payload.execution.team_role).toBe('coordinator');
  expect(coordinator.payload.team_coordination).toBe(true);
  expect(coordinator.payload.guided).toEqual(runs[1].guided);
  for (const key of ['autonomy_approval', 'autonomy_policy', 'model_budgets', 'base'])
    expect(recovered[key]).toEqual(runs[1][key]);
  expect(recovered.model_requests).toBe(0);
  expect((await read()).steps[2].status).not.toBe('complete');
});
