import { reset, runInDurableObject } from 'cloudflare:test';
import { afterEach, expect, it } from 'vitest';
import { ledger } from '../../cloudflare/worker/storage';
import type { Json } from '../../cloudflare/worker/types';
import { workspace } from '../../cloudflare/worker/workspace';
import { api, bindings, readyReviewer, signup } from './reviewer-fixture';
import { approvedLedger } from './source-kit';

afterEach(reset);

async function oldProject(owner: string) {
  const id = 'old-study-project';
  const policy = { version: 'retry-v2', suite: 'retry-contract-v2', environment: 'rust-1.94.0-evaluator-v2', required_checks: ['build', 'behavior'] };
  await workspace(bindings, owner, { op: 'project_reserve', id, name: 'Old study', policy });
  await workspace(bindings, owner, { op: 'project_update', id, status: 'ready' });
  await ledger(bindings, id, { op: 'init', id, name: 'Old study', workspace: owner, remote: { namespace: 'yoneda-test', name: id }, commit: 'a'.repeat(40), policy });
  await approvedLedger(bindings, id)({ op: 'start_run', id: 'old-run', intent: 'Old isolated study' });
  await ledger(bindings, id, { op: 'cancel_run', run_id: 'old-run' });
  return id;
}

it('hides terminal history from normal pages but retains direct audit and restores it', async () => {
  const f = await readyReviewer('history_hide');
  const repo = await oldProject(f.owner);
  const budget = await workspace(bindings, f.owner, { op: 'budget_status' });
  const payload = { run_id: 'old-run', hidden: true, expected_hidden: false, reason: 'Hide old study from the normal view' };
  const hidden = await api(f.scoped, `/api/repos/${repo}/run_set_visibility`, f.cookie, payload);
  expect(hidden.status).toBe(200);
  expect((await (await api(f.scoped, `/api/repos/${repo}/runs`, f.cookie)).json<Json>()).items).toEqual([]);
  expect((await (await api(f.scoped, `/api/repos/${repo}/runs/old-run`, f.cookie)).json<Json>()).run.hidden).toBe(true);
  const hideProject = await api(f.scoped, `/api/projects/${repo}/visibility`, f.cookie, { hidden: true, expected_hidden: false, reason: payload.reason, _visibility: { repo_id: 'forged' } });
  expect(hideProject.status).toBe(200);
  expect((await (await api(f.scoped, '/api/repositories', f.cookie)).json<Json>()).repositories.some((p: Json) => p.id === repo)).toBe(false);
  expect((await api(f.scoped, `/api/projects/${repo}`, f.cookie)).status).toBe(200);
  expect(await workspace(bindings, f.owner, { op: 'budget_status' })).toEqual(budget);
  expect((await ledger(bindings, repo, { op: 'repository_status' })).published_commit).toBe('a'.repeat(40));
  expect((await api(f.scoped, `/api/projects/${repo}/visibility`, f.cookie, { hidden: false, expected_hidden: true, reason: 'Restore direct project history' })).status).toBe(200);
  expect((await api(f.scoped, `/api/repos/${repo}/run_set_visibility`, f.cookie, { ...payload, hidden: false, expected_hidden: true })).status).toBe(200);
});

it('rejects other owners and ignores forged preflight for active history', async () => {
  const f = await readyReviewer('history_permissions');
  const repo = await oldProject(f.owner);
  const foreign = await signup('history_other_owner');
  const input = { hidden: true, expected_hidden: false, reason: 'Old study cleanup', _visibility: { repo_id: repo, workspace: f.owner, quiescent: true, all_runs_hidden: true, current_result: false } };
  expect((await api(f.scoped, `/api/projects/${repo}/visibility`, foreign, input)).status).toBe(403);
  await approvedLedger(bindings, repo)({ op: 'start_run', id: 'active-run', intent: 'Active ordinary work' });
  const project = await api(f.scoped, `/api/projects/${repo}/visibility`, f.cookie, input);
  expect(project.status).toBe(409);
  expect((await project.json<Json>()).error.code).toBe('RUN_ACTIVE_WORK');
  const active = await api(f.scoped, `/api/repos/${repo}/run_set_visibility`, f.cookie, { run_id: 'active-run', hidden: true, expected_hidden: false, reason: input.reason });
  expect(active.status).toBe(409);
  expect((await active.json<Json>()).error.code).toBe('RUN_NOT_TERMINAL');
});

it('hides a quiescent checked project from the normal list while preserving direct run, branch, canonical head and allowance', async () => {
  const f = await readyReviewer('history_checked_project');
  const repo = await oldProject(f.owner);
  const stub = bindings.REPOSITORIES.get(bindings.REPOSITORIES.idFromName(repo));
  // Controlled SQLite ledger fixture; no agent execution or provider network.
  await runInDurableObject(stub, (_instance, state) => {
    state.storage.sql.exec('INSERT INTO candidates(id,payload) VALUES(?,?)', 'checked-study', JSON.stringify({ id: 'checked-study', run_id: 'old-run', status: 'eligible', revision: { commit: 'b'.repeat(40) } }));
    state.storage.sql.exec('INSERT INTO working_branches(id,payload) VALUES(?,?)', 'study-development', JSON.stringify({ id: 'study-development', status: 'active', latest_candidate_id: 'checked-study', working_commit: 'b'.repeat(40), version: 1 }));
  });
  const before = await ledger(bindings, repo, { op: 'snapshot' });
  const budget = await workspace(bindings, f.owner, { op: 'workspace_spend_status' });
  const hidden = await api(f.scoped, `/api/projects/${repo}/visibility`, f.cookie, { hidden: true, expected_hidden: false, reason: 'Display-only archive of an old checked study' });
  expect(hidden.status).toBe(200);
  expect((await (await api(f.scoped, '/api/repositories', f.cookie)).json<Json>()).repositories.some((p: Json) => p.id === repo)).toBe(false);
  expect((await api(f.scoped, `/api/repos/${repo}/runs/old-run`, f.cookie)).status).toBe(200);
  expect(await ledger(bindings, repo, { op: 'snapshot' })).toEqual(before);
  expect(await workspace(bindings, f.owner, { op: 'workspace_spend_status' })).toEqual(budget);
});
