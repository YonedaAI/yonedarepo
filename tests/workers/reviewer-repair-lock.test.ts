import { reset, runInDurableObject } from 'cloudflare:test';
import { afterEach, expect, it } from 'vitest';
import type { Json } from '../../cloudflare/worker/types';
import { ledger } from '../../cloudflare/worker/storage';
import { workspace } from '../../cloudflare/worker/workspace';
import { reviewerRepairFingerprint } from '../../cloudflare/worker/reviewer-trial';
import { api, bindings, readyReviewer } from './reviewer-fixture';

afterEach(reset);

it('reopens only the completed trial being repaired and keeps its lock and budget', async () => {
  const f = await readyReviewer('review_repair_lock');
  const started = await api(f.scoped, '/api/reviewer/trial', f.cookie, {
    request_id: 'repair-lock-trial-12345678',
  });
  expect(started.status).toBe(200);
  const trial = await started.json<Json>();
  await workspace(f.scoped, f.owner, {
    op: 'budget_reserve',
    id: 'preserve-review-budget',
    amount: 123456,
  });
  const budget = await workspace(f.scoped, f.owner, { op: 'budget_status' });
  const repository = await ledger(f.scoped, f.repo, {
    op: 'repository_status',
    _workspace: f.owner,
  });
  const detail = await ledger(f.scoped, f.repo, {
    op: 'run_detail',
    run_id: trial.run_id,
    _workspace: f.owner,
  });
  const selected = detail.team_tasks.find((task: Json) => task.task_id === 'trail-data');
  expect(selected).toBeDefined();

  const stub = bindings.REPOSITORIES.get(bindings.REPOSITORIES.idFromName(f.repo));
  await runInDurableObject(stub, (_instance, state) => {
    state.storage.sql.exec(
      "UPDATE runs SET payload=json_set(payload,'$.status','ready') WHERE id=?",
      trial.run_id,
    );
    state.storage.sql.exec(
      "UPDATE team_tasks SET payload=json_set(payload,'$.status','complete','$.output',json('{}')) WHERE json_extract(payload,'$.run_id')=?",
      trial.run_id,
    );
    state.storage.sql.exec(
      "UPDATE executions SET payload=json_set(payload,'$.status','completed') WHERE json_extract(payload,'$.run_id')=?",
      trial.run_id,
    );
  });
  const completed = await api(f.scoped, '/api/reviewer', f.cookie);
  expect(completed.status).toBe(200);
  expect(await completed.json<Json>()).toMatchObject({ active_trial: null });

  const repair = {
    request_id: 'reviewer-repair-request-123456',
    expected_commit: repository.head_commit,
    expected_version: repository.version,
    run_id: trial.run_id,
    expected_plan_revision: detail.run.team_plan_revision,
    task_ids: ['trail-data'],
    expected_task_revisions: { 'trail-data': selected.revision },
    owner_brief: 'Repair the trail data task',
  };
  const foreignScope = await api(f.scoped, '/api/repos/foreign/repair_team', f.cookie, repair);
  expect(foreignScope.status).toBe(403);
  expect((await workspace(f.scoped, f.owner, { op: 'reviewer_status' })).active_trial).toBeNull();

  const changedId = await api(f.scoped, `/api/repos/${f.repo}/repair_team`, f.cookie, {
    ...repair,
    run_id: 'reviewer-changed-trial-id',
  });
  expect(changedId.status).toBe(409);
  expect((await workspace(f.scoped, f.owner, { op: 'reviewer_status' })).active_trial).toBeNull();

  const failedRepair = await api(f.scoped, `/api/repos/${f.repo}/repair_team`, f.cookie, {
    ...repair,
    request_id: 'reviewer-repair-failed-123456',
    expected_version: repository.version + 1,
  });
  expect(failedRepair.status).toBe(409);
  expect((await workspace(f.scoped, f.owner, { op: 'reviewer_status' })).active_trial).toBeNull();
  const reconciled = await api(f.scoped, '/api/reviewer', f.cookie);
  expect(await reconciled.json<Json>()).toMatchObject({ active_trial: null });

  const staleEpoch = (await workspace(f.scoped, f.owner, { op: 'reviewer_status' })).trial_epoch;
  const fingerprint = await reviewerRepairFingerprint(repair);
  await workspace(f.scoped, f.owner, {
    op: 'reviewer_trial_reopen',
    id: trial.run_id,
    request_id: repair.request_id,
    fingerprint,
  });
  const pendingEpoch = (await workspace(f.scoped, f.owner, { op: 'reviewer_status' })).trial_epoch;
  await workspace(f.scoped, f.owner, {
    op: 'reviewer_trial_complete',
    id: trial.run_id,
    expected_epoch: staleEpoch,
  });
  expect(await workspace(f.scoped, f.owner, { op: 'reviewer_status' })).toMatchObject({
    active_trial: trial.run_id,
    _active_trial_status: 'repair_pending',
  });
  const conflictingReplay = await api(f.scoped, `/api/repos/${f.repo}/repair_team`, f.cookie, {
    ...repair,
    owner_brief: 'Different repair under the same request ID',
  });
  expect(conflictingReplay.status).toBe(409);
  expect((await workspace(f.scoped, f.owner, { op: 'reviewer_status' })).active_trial).toBe(trial.run_id);

  const repaired = await api(f.scoped, `/api/repos/${f.repo}/repair_team`, f.cookie, repair);
  expect(repaired.status).toBe(200);
  expect(await repaired.json<Json>()).toMatchObject({ run_id: trial.run_id, status: 'repairing' });
  await workspace(f.scoped, f.owner, {
    op: 'reviewer_trial_complete',
    id: trial.run_id,
    expected_epoch: pendingEpoch,
  });
  expect((await workspace(f.scoped, f.owner, { op: 'reviewer_status' })).active_trial).toBe(trial.run_id);
  expect(await workspace(f.scoped, f.owner, { op: 'budget_status' })).toEqual(budget);

  const another = await api(f.scoped, '/api/reviewer/trial', f.cookie, {
    request_id: 'new-reviewer-trial-12345678',
  });
  expect(another.status).toBe(409);
  expect((await another.json<Json>()).error.code).toBe('TRIAL_ACTIVE');
});

it('fences a terminal completion read before repair of an active trial', async () => {
  const f = await readyReviewer('review_active_terminal_race');
  const started = await api(f.scoped, '/api/reviewer/trial', f.cookie, {
    request_id: 'active-terminal-trial-123456',
  });
  const trial = await started.json<Json>();
  const repo = await ledger(f.scoped, f.repo, { op: 'repository_status', _workspace: f.owner });
  const detail = await ledger(f.scoped, f.repo, {
    op: 'run_detail', run_id: trial.run_id, _workspace: f.owner,
  });
  const task = detail.team_tasks.find((item: Json) => item.task_id === 'trail-data');
  const stub = bindings.REPOSITORIES.get(bindings.REPOSITORIES.idFromName(f.repo));
  await runInDurableObject(stub, (_instance, state) => {
    state.storage.sql.exec("UPDATE runs SET payload=json_set(payload,'$.status','ready') WHERE id=?", trial.run_id);
    state.storage.sql.exec("UPDATE team_tasks SET payload=json_set(payload,'$.status','complete','$.output',json('{}')) WHERE json_extract(payload,'$.run_id')=?", trial.run_id);
    state.storage.sql.exec("UPDATE executions SET payload=json_set(payload,'$.status','completed') WHERE json_extract(payload,'$.run_id')=?", trial.run_id);
  });
  const observedEpoch = (await workspace(f.scoped, f.owner, { op: 'reviewer_status' })).trial_epoch;
  const repaired = await api(f.scoped, `/api/repos/${f.repo}/repair_team`, f.cookie, {
    request_id: 'active-terminal-repair-123456',
    expected_commit: repo.head_commit,
    expected_version: repo.version,
    run_id: trial.run_id,
    expected_plan_revision: detail.run.team_plan_revision,
    task_ids: ['trail-data'],
    expected_task_revisions: { 'trail-data': task.revision },
    owner_brief: 'Repair while the terminal status read is delayed',
  });
  expect(repaired.status).toBe(200);
  await workspace(f.scoped, f.owner, {
    op: 'reviewer_trial_complete', id: trial.run_id, expected_epoch: observedEpoch,
  });
  expect((await workspace(f.scoped, f.owner, { op: 'reviewer_status' })).active_trial).toBe(trial.run_id);
});
