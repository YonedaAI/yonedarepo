import { reset, runInDurableObject } from 'cloudflare:test';
import { afterEach, expect, it } from 'vitest';
import { reviewerGuard } from '../../cloudflare/worker/reviewer';
import { sitePolicy } from '../../cloudflare/worker/site-policy';
import { ledger } from '../../cloudflare/worker/storage';
import type { Json } from '../../cloudflare/worker/types';
import { workspace } from '../../cloudflare/worker/workspace';
import { platformProject } from './platform-fixture';
import { api, bindings, readyReviewer, signup } from './reviewer-fixture';

afterEach(reset);

async function ordinaryProject(owner: string, id: string) {
  await platformProject(bindings, owner, id, undefined, sitePolicy);
}

it('allows a reviewer to save provider settings and reserve a normal project without changing legacy approvals', async () => {
  const f = await readyReviewer('parity_settings');
  const before = await workspace(bindings, f.owner, { op: 'reviewer_status' });
  const saved = await api(f.scoped, '/api/settings/providers/codex', f.cookie, { key: 'synthetic-personal-provider-key', model: 'gpt-5.6-luna' });
  expect(saved.status).toBe(200);
  const created = await api(f.scoped, '/api/projects', f.cookie, { request_id: 'ordinary-project-request-1234', name: 'My normal project' });
  expect(created.status).toBe(202);
  const project = await created.json<Json>();
  expect((await api(f.scoped, `/api/projects/${project.id}`, f.cookie)).status).toBe(200);
  expect(await workspace(bindings, f.owner, { op: 'reviewer_status' })).toEqual(before);
  expect((await workspace(bindings, f.owner, { op: 'settings' })).providers.some((p: Json) => p.id === 'codex')).toBe(true);
});

it('allows normal owner runs and grant lifecycle while rejecting foreign tenants and cross-origin writes', async () => {
  const f = await readyReviewer('parity_owner');
  await ordinaryProject(f.owner, 'parity-normal');
  const run = await api(f.scoped, '/api/repos/parity-normal/start_run', f.cookie, { id: 'ordinary-run', intent: 'Inspect my source', agents: [{ provider: 'codex', model: 'gpt-5.6-luna', connection: 'reviewer-codex', strategy: 'Inspect source' }] });
  expect(run.status).toBe(200);
  expect((await run.json<Json>()).id).toBe('ordinary-run');
  const issued = await api(f.scoped, '/api/repos/parity-normal/grants', f.cookie, { label: 'Personal agent', scope: 'read', days: 1 });
  expect(issued.status).toBe(200);
  const grant = await issued.json<Json>();
  expect(grant.token).toMatch(/^yoneda\./);
  expect((await api(f.scoped, '/api/repos/parity-normal/grants', f.cookie, { revoke: grant.id })).status).toBe(200);
  const listed = await (await api(f.scoped, '/api/repos/parity-normal/grants', f.cookie)).json<Json>();
  expect(listed.grants[0].revoked).toBe(true);
  expect(JSON.stringify(listed)).not.toContain('token_hash');
  const foreign = await signup('parity_foreign');
  expect((await api(f.scoped, '/api/repos/parity-normal/grants', foreign, { label: 'Wrong tenant', scope: 'read' })).status).toBe(403);
  const crossed = await bindings.SELF.fetch('https://yoneda/api/settings/providers/codex', { method: 'POST', headers: { cookie: f.cookie, origin: 'https://foreign.example' }, body: JSON.stringify({ key: 'synthetic-key' }) });
  expect(crossed.status).toBe(401);
});

it('preserves reviewer expiry and revocation across ordinary owner routes', async () => {
  const f = await readyReviewer('parity_expiry');
  const principal = { role: 'user' as const, workspace: f.owner, reviewer: true };
  const stub = bindings.WORKSPACES.get(bindings.WORKSPACES.idFromName(`account:${f.owner}`));
  await runInDurableObject(stub, (_instance, state) => {
    state.storage.sql.exec("UPDATE workspace_records SET payload=json_set(payload,'$.expires',0) WHERE id='reviewer_policy'");
  });
  expect((await reviewerGuard(new Request('https://yoneda/api/projects', { method: 'POST' }), f.scoped, principal))?.status).toBe(401);
  expect((await api(f.scoped, '/api/projects', f.cookie, { request_id: 'expired-project-request-1234', name: 'Denied' })).status).toBe(401);
  const revoked = await readyReviewer('parity_revoked');
  await workspace(bindings, revoked.owner, { op: 'reviewer_revoke' });
  expect((await api(revoked.scoped, '/api/settings', revoked.cookie)).status).toBe(401);
});

it('allows all ordinary owner commands on the legacy entry repository without adding campaign authority', async () => {
  const f = await readyReviewer('parity_same_entry');
  const principal = { role: 'user' as const, workspace: f.owner, reviewer: true };
  const snapshot = await ledger(bindings, f.repo, { op: 'snapshot' });
  for (const action of ['start_run', 'create_working_branch', 'grants', 'repair_team', 'update_policy']) {
    const request = new Request(`https://yoneda/api/repos/${f.repo}/${action}`, { method: 'POST', body: JSON.stringify({ adaptive_team: { version: 1 }, run_id: 'new-owner-run' }) });
    expect(await reviewerGuard(request, f.scoped, principal), action).toBeNull();
  }
  expect((await ledger(bindings, f.repo, { op: 'snapshot' })).seq).toBe(snapshot.seq);
  const oldApproval = await workspace(bindings, f.owner, { op: 'reviewer_status' });
  const branch = await api(f.scoped, `/api/repos/${f.repo}/create_working_branch`, f.cookie, { id: 'owner-development', expected_commit: f.head, expected_version: 0 });
  expect(branch.status).toBe(200);
  const grant = await api(f.scoped, `/api/repos/${f.repo}/grants`, f.cookie, { label: 'Owner key on existing entry', scope: 'read', days: 1 });
  expect(grant.status).toBe(200);
  const started = await api(f.scoped, `/api/repos/${f.repo}/start_run`, f.cookie, {
    id: 'normal-owner-entry-run', intent: 'Compare approaches on my existing project',
    working_branch_id: 'owner-development', expected_working_commit: f.head, expected_working_version: 0,
    adaptive_team: { version: 1, requested_agents: [{ connection: 'reviewer-codex', role: 'builder' }, { connection: 'reviewer-claude-sonnet-5-5', role: 'review' }] },
  });
  expect(started.status).toBe(200);
  const run = await started.json<Json>();
  expect(run.id).toBe('normal-owner-entry-run');
  expect(run.mode).toBe('compare');
  expect(run.campaign).toBeUndefined();
  expect(run.adaptive_team).toBeUndefined();
  expect(await workspace(bindings, f.owner, { op: 'reviewer_status' })).toEqual(oldApproval);
});
