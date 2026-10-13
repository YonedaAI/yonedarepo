import appProfile from '../../fixtures/event-booking/app-profile.json';
import { ledger } from '../../cloudflare/worker/storage';
import type { Env, Json } from '../../cloudflare/worker/types';
import { api } from './reviewer-fixture';
import { reset } from 'cloudflare:test';
import { afterEach, expect, it } from 'vitest';
import { checkedFinal } from '../../cloudflare/worker/reviewer-campaign-evidence';
import { campaignModelBudgets, campaignTrialRequest } from '../../cloudflare/worker/reviewer-campaign-policy';
import { reviewerCampaignStatus } from '../../cloudflare/worker/reviewer-campaign-trial';
import { workspace } from '../../cloudflare/worker/workspace';
import { bindings, readyReviewer } from './reviewer-fixture';

afterEach(async () => { await reset(); });
it('approves the fresh envelope before GLM evidence and enables reviewer entry separately', async () => {
  const f = await readyReviewer();
  const id = 'reviewer-event-booking-20261012-v1';
  const approval = { version: 1, profile: 'reviewer-event-booking-v1', audience: 'owner',
    repo_ids: [f.repo], expires: Date.UTC(2026, 9, 23), limit_microusd: 50000000,
    chain_limit_microusd: 5000000, buckets: { routine: 35000000, opus: 10000000, reserve: 5000000 },
    model_budgets: campaignModelBudgets, entry: { repo_id: f.repo, glm_evidence_run_id: null } };
  await workspace(bindings, f.owner, { op: 'campaign_configure', id, expected_version: 0, approval });
  await workspace(bindings, f.owner, { op: 'campaign_enable', id, expected_version: 1,
    expected_revision: 1, local_gate_receipt: 'synthetic gate receipt' });
  const status = await reviewerCampaignStatus(bindings, f.owner);
  expect(status).toMatchObject({ campaign: { enabled: false }, enabled: false,
    approval: { entry: { glm_evidence_run_id: null } }, budget: { limit_microusd: 50000000, charged_microusd: 0 } });
  const owner = await workspace(bindings, f.owner, { op: 'campaign_bind_run', id, version: 1,
    repo_id: f.repo, run_id: 'glm-evidence', chain_id: 'glm-evidence', bucket: 'routine', purpose: 'routine',
    access: 'owner', model_budgets: [campaignModelBudgets[0]] });
  expect(owner.access).toBe('owner');
  await expect(workspace(bindings, f.owner, { op: 'campaign_bind_run', id, version: 1,
    repo_id: f.repo, run_id: 'premature-reviewer', chain_id: 'premature-reviewer', bucket: 'routine', purpose: 'routine',
    access: 'reviewer', model_budgets: [campaignModelBudgets[1]] })).rejects.toMatchObject({ code: 'FORBIDDEN' });
});
it('freezes logical multi-agent roles, working revision, shared two rounds and original Opus budget', () => {
  const request = campaignTrialRequest('new-run', 1, { working_commit: 'a'.repeat(40), version: 2 });
  expect(request).toMatchObject({ mode: 'collaborate', working_branch_id: 'campaign-development',
    expected_working_commit: 'a'.repeat(40), expected_working_version: 2,
    autonomy_policy: { enabled: true, max_repair_rounds: 2 },
    repair_escalation: { max_executions: 1, repair_round: 2, after_cheaper_repair_failure: true } });
  expect(request.agents).toHaveLength(2);
  expect(new Set(request.agents.map(agent => agent.strategy)).size).toBe(2);
  expect(request.agents.every(agent => agent.model === 'gpt-5.6-luna')).toBe(true);
  expect(request.model_budgets[0].spend_limit_microusd).toBe(5000000);
});
it('requires the exact independently checked collaborative final and app revision', () => {
  const candidate = { id: 'final', run_id: 'run', execution: 'integrator', status: 'eligible',
    evaluation: 'evaluation', revision: { repository: 'test/booking', commit: 'a'.repeat(40) } };
  const detail = { run: { id: 'run', mode: 'collaborate', status: 'ready',
    policy: { version: 'v1', suite: 'fullstack', environment: 'isolated' } }, candidates: [candidate],
    executions: [{ id: 'integrator', team_role: 'integrator' }], evaluations: [{ id: 'evaluation', candidate: 'final',
      revision: candidate.revision, policy: 'v1', suite: 'fullstack', environment: 'isolated',
      app: { revision: candidate.revision.commit, bundle_digest: 'b'.repeat(64) }, checks: [{ name: 'build', status: 'pass' }] }] };
  expect(checkedFinal(detail)).toEqual(candidate);
  detail.executions[0].team_role = 'specialist';
  expect(checkedFinal(detail)).toBeUndefined();
  detail.executions[0].team_role = 'integrator';
  detail.evaluations[0].app.revision = 'c'.repeat(40);
  expect(checkedFinal(detail)).toBeUndefined();
});

it('configures sealed owner connections before evidence without starting provider requests', async () => {
  const f = await readyReviewer();
  const repo = 'fresh-booking';
  const policy = { version: 'booking-v1', suite: 'commands-v1', environment: 'linux-node24-rust1.94-v1',
    required_checks: ['build'], build: { app: appProfile, checks: [{ name: 'build', argv: ['node', 'build.mjs'], timeout_seconds: 30 }] } };
  await ledger(bindings, repo, { op: 'init', id: repo, name: 'Fresh booking', workspace: f.owner,
    remote: { namespace: 'yoneda-test', name: repo }, commit: 'a'.repeat(40), policy });
  await ledger(bindings, repo, { op: 'create_working_branch', id: 'campaign-development',
    expected_commit: 'a'.repeat(40), expected_version: 0, _workspace: f.owner });
  const scoped = { ...f.scoped, ZAI_KEY: { get: async () => 'synthetic-owner-coding-plan' } } as Env;
  const response = await api(scoped, '/api/admin/reviewer/campaign/configure', '',
    { username: f.owner, repo_id: repo }, true);
  const configured = await response.json<Json>();
  expect(response.status).toBe(200);
  expect(configured).toMatchObject({ enabled: false, limit_microusd: 50000000, charged_microusd: 0 });
  expect(JSON.stringify(configured)).not.toMatch(/synthetic-owner|sealed|ciphertext/);
  const providers = await workspace(bindings, f.owner, { op: 'settings' });
  expect(providers.providers).toEqual(expect.arrayContaining([
    expect.objectContaining({ id: 'owner-campaign-glm-20261012', model: 'glm-5.3-flash' }),
    expect.objectContaining({ id: 'owner-campaign-sonnet-20261012', model: 'claude-sonnet-5-5' }),
    expect.objectContaining({ id: 'reviewer-campaign-codex-20261012', model: 'gpt-5.6-luna' }),
    expect.objectContaining({ id: 'reviewer-campaign-opus-20261012', model: 'claude-opus-5-5' }),
  ]));
  expect((await ledger(bindings, repo, { op: 'snapshot' })).runs).toEqual([]);
});
