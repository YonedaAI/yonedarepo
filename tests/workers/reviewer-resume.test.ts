import { evictDurableObject, reset, runInDurableObject } from 'cloudflare:test';
import { afterEach, expect, it } from 'vitest';
import type { Env, Json } from '../../cloudflare/worker/types';
import { ledger } from '../../cloudflare/worker/storage';
import { workspace } from '../../cloudflare/worker/workspace';
import { api, bindings, readyReviewer, signup } from './reviewer-fixture';

afterEach(reset);

// Inject only transport failures; successful commands use real Rust/Wasm DO SQLite.
function intercept(scoped: Env, fetch: (command: Json, commit: () => Promise<Response>) => Promise<Response>): Env {
  const real = scoped.REPOSITORIES;
  return { ...scoped, REPOSITORIES: {
    idFromName: (name: string) => real.idFromName(name),
    get: (id: DurableObjectId) => ({ fetch: (url: string, options: RequestInit) =>
      fetch(JSON.parse(String(options.body)), () => real.get(id).fetch(url, options)) }),
  } } as unknown as Env;
}

async function reload(owner: string, repo: string) {
  await evictDurableObject(bindings.WORKSPACES.get(bindings.WORKSPACES.idFromName(`account:${owner}`)));
  await evictDurableObject(bindings.REPOSITORIES.get(bindings.REPOSITORIES.idFromName(repo)));
}

it('preserves a failed start reservation across reload and resumes the exact ID with fixed approval', async () => {
  const f = await readyReviewer('resume_failure');
  const id = 'reviewer-failed-start-12345678';
  const failing = intercept(f.scoped, async (command, commit) => {
    if (command.op === 'start_run') throw new Error('Simulated start_run transport failure before commit');
    return commit();
  });
  const first = await api(failing, '/api/reviewer/trial', f.cookie, { request_id: 'failed-start-12345678' });
  expect(first.status).toBe(409);
  expect((await ledger(bindings, f.repo, { op: 'snapshot' })).runs).toHaveLength(0);
  await reload(f.owner, f.repo);
  const status = await api(f.scoped, '/api/reviewer', f.cookie);
  expect(await status.json()).toMatchObject({ active_trial: id });
  const another = await api(f.scoped, '/api/reviewer/trial', f.cookie, { request_id: 'different-id-12345678' });
  expect(another.status).toBe(409);
  expect(await another.json()).toMatchObject({ error: { code: 'TRIAL_ACTIVE' } });
  // No original client request ID survives reload. Caller fields cannot redirect resume.
  const resumed = await api(f.scoped, '/api/reviewer/resume', f.cookie, {
    request_id: 'different-id-12345678', repo_id: 'foreign', run_id: 'foreign',
    agents: [{ model: 'expensive' }], intent: 'attacker brief', budget: 999,
  });
  expect(resumed.status).toBe(200);
  expect(await resumed.json()).toMatchObject({ repo_id: f.repo, run_id: id });
  const snapshot = await ledger(bindings, f.repo, { op: 'snapshot' });
  expect(snapshot.runs).toHaveLength(1);
  expect(snapshot.executions).toHaveLength(2);
  expect(snapshot.runs[0]).toMatchObject({ id, mode: 'collaborate' });
  expect(snapshot.runs[0].intent).toContain('San Jose');
  expect(snapshot.runs[0].agents.map((a: Json) => [a.provider, a.model])).toEqual([
    ['codex', 'gpt-5.6-luna'], ['claude', 'claude-sonnet-5-5'],
  ]);
  expect(snapshot.runs[0].model_budgets.reduce((sum: number, b: Json) => sum + b.spend_limit_microusd, 0)).toBe(5_000_000);
  expect((await workspace(bindings, f.owner, { op: 'reviewer_status' })).active_trial).toBe(id);
});

it('resumes after a lost committed acknowledgement and failed readback without duplicate events or jobs', async () => {
  const f = await readyReviewer('resume_lostack');
  let lost = false;
  const failing = intercept(f.scoped, async (command, commit) => {
    if (lost && command.op === 'snapshot') throw new Error('Simulated unavailable acknowledgement readback');
    const response = await commit();
    if (command.op === 'start_run' && response.ok) {
      lost = true;
      await response.body?.cancel();
      throw new Error('Simulated lost committed start_run acknowledgement');
    }
    return response;
  });
  const first = await api(failing, '/api/reviewer/trial', f.cookie, { request_id: 'lost-ack-resume-12345678' });
  expect(first.status).toBe(409);
  expect(lost).toBe(true);
  const before = await ledger(bindings, f.repo, { op: 'snapshot' });
  const outbox = await ledger(bindings, f.repo, { op: 'outbox' });
  expect(before.runs).toHaveLength(1);
  expect(before.executions).toHaveLength(2);
  await reload(f.owner, f.repo);
  const responses = await Promise.all([1, 2, 3].map(() => api(f.scoped, '/api/reviewer/resume', f.cookie, {})));
  expect(responses.map(r => r.status)).toEqual([200, 200, 200]);
  for (const r of responses) expect(await r.json()).toMatchObject({ run_id: before.runs[0].id });
  const after = await ledger(bindings, f.repo, { op: 'snapshot' });
  expect(after.seq).toBe(before.seq);
  expect(after.runs).toEqual(before.runs);
  expect(after.executions).toEqual(before.executions);
  expect(outbox.jobs.filter((job: Json) => job.kind === 'agent')).toHaveLength(2);
  expect(await ledger(bindings, f.repo, { op: 'outbox' })).toEqual(outbox);
});

it('keeps the active slot while an original start is in flight and concurrent resumes create one run', async () => {
  const f = await readyReviewer('resume_race');
  let arrived!: () => void;
  const waiting = new Promise<void>(resolve => { arrived = resolve; });
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let paused = false;
  const scoped = intercept(f.scoped, async (command, commit) => {
    if (command.op === 'start_run' && !paused) {
      paused = true;
      arrived();
      await gate;
    }
    return commit();
  });
  const original = api(scoped, '/api/reviewer/trial', f.cookie, { request_id: 'in-flight-trial-12345678' });
  await waiting;
  try {
    expect((await ledger(bindings, f.repo, { op: 'snapshot' })).runs).toHaveLength(0);
    const conflict = await api(f.scoped, '/api/reviewer/trial', f.cookie, { request_id: 'different-id-12345678' });
    expect(await conflict.json()).toMatchObject({ error: { code: 'TRIAL_ACTIVE' } });
    const resumed = await Promise.all([1, 2, 3].map(() => api(f.scoped, '/api/reviewer/resume', f.cookie, {})));
    expect(resumed.map(r => r.status)).toEqual([200, 200, 200]);
    for (const r of resumed) expect(await r.json()).toMatchObject({ run_id: 'reviewer-in-flight-trial-12345678' });
  } finally {
    release();
  }
  expect((await original).status).toBe(200);
  const snapshot = await ledger(bindings, f.repo, { op: 'snapshot' });
  expect(snapshot.runs).toHaveLength(1);
  expect(snapshot.executions).toHaveLength(2);
  expect((await workspace(bindings, f.owner, { op: 'reviewer_status' })).active_trial).toBe(snapshot.runs[0].id);
});

it('requires an active trial and reviewer authorization without granting generic start permissions', async () => {
  const f = await readyReviewer('resume_access');
  const empty = await api(f.scoped, '/api/reviewer/resume', f.cookie, {});
  expect(empty.status).toBe(409);
  expect(await empty.json()).toMatchObject({ error: { code: 'NO_ACTIVE_TRIAL' } });
  expect((await api(f.scoped, '/api/reviewer/resume', '', {})).status).toBe(401);
  const ordinary = await signup('ordinary_user');
  expect((await api(f.scoped, '/api/reviewer/resume', ordinary, {})).status).toBe(403);
  expect((await api(f.scoped, '/api/reviewer/resume', f.cookie)).status).toBe(404);
  expect((await api(f.scoped, `/api/repos/${f.repo}/start_run`, f.cookie, {})).status).toBe(403);
  expect((await ledger(bindings, f.repo, { op: 'snapshot' })).runs).toHaveLength(0);
});

it('resumes only the authenticated workspace and rejects expired or revoked reviewers', async () => {
  const alice = await readyReviewer('resume_alice');
  const bob = await readyReviewer('resume_bob');
  const id = 'reviewer-tenant-resume-12345678';
  await workspace(bindings, alice.owner, { op: 'reviewer_trial', id });
  const foreign = await api(bob.scoped, '/api/reviewer/resume', bob.cookie, { repo_id: alice.repo, run_id: id });
  expect(await foreign.json()).toMatchObject({ error: { code: 'NO_ACTIVE_TRIAL' } });
  const stub = bindings.WORKSPACES.get(bindings.WORKSPACES.idFromName(`account:${alice.owner}`));
  await runInDurableObject(stub, (_instance, state) => {
    state.storage.sql.exec("UPDATE workspace_records SET payload=json_set(payload,'$.expires',0) WHERE id='reviewer_policy'");
  });
  expect((await api(alice.scoped, '/api/reviewer/resume', alice.cookie, {})).status).toBe(401);
  await workspace(bindings, bob.owner, { op: 'reviewer_trial', id });
  await workspace(bindings, bob.owner, { op: 'reviewer_revoke' });
  expect((await api(bob.scoped, '/api/reviewer/resume', bob.cookie, {})).status).toBe(401);
  for (const f of [alice, bob]) expect((await ledger(bindings, f.repo, { op: 'snapshot' })).runs).toHaveLength(0);
});

it('releases only terminal trial slots when status reloads, retaining history and spend', async () => {
  const f = await readyReviewer('resume_terminal');
  const response = await api(f.scoped, '/api/reviewer/trial', f.cookie, { request_id: 'terminal-slot-12345678' });
  const trial = await response.json<Json>();
  expect((await (await api(f.scoped, '/api/reviewer', f.cookie)).json<Json>()).active_trial).toBe(trial.run_id);
  await ledger(f.scoped, f.repo, { op: 'cancel_run', run_id: trial.run_id });
  const budget = await workspace(bindings, f.owner, { op: 'budget_status' });
  const reloaded = await (await api(f.scoped, '/api/reviewer', f.cookie)).json<Json>();
  expect(reloaded.active_trial).toBeNull();
  expect(reloaded.budget).toEqual(budget);
  const snapshot = await ledger(bindings, f.repo, { op: 'snapshot' });
  expect(snapshot.runs).toHaveLength(1);
  expect(snapshot.runs[0].status).toBe('cancelled');
});
