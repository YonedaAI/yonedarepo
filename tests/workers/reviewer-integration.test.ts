import { evictDurableObject, reset, runInDurableObject } from 'cloudflare:test';
import { afterEach, expect, it } from 'vitest';
import { accountPrincipal } from '../../cloudflare/worker/accounts';
import { ledger } from '../../cloudflare/worker/storage';
import type { Json } from '../../cloudflare/worker/types';
import { workspace } from '../../cloudflare/worker/workspace';
import { api, bindings, expires, readyReviewer, reviewerFixture, signup, testKeys } from './reviewer-fixture';

afterEach(reset);

it('provisions a public account only as admin, persists immutable policy and exposes no funded keys', async () => {
  const cookie = await signup('review_target');
  expect((await api(bindings, '/api/admin/reviewer/provision', cookie, { username: 'review_target' })).status).toBe(403);
  expect(await workspace(bindings, 'review_target', { op: 'reviewer_status' })).toBeNull();
  const f = await reviewerFixture();
  expect(f.provisioned).toMatchObject({ expires, budget_microusd: 50_000_000, status: 'provisioning' });
  expect(f.send).toHaveBeenCalledWith(expect.objectContaining({ kind: 'provision', workspace: f.owner, repo_id: f.repo }), { delaySeconds: 0 });
  const principal = await accountPrincipal(new Request('https://yoneda/api/repositories', { headers: { cookie: f.cookie } }), f.scoped);
  expect(principal).toMatchObject({ role: 'user', workspace: f.owner, reviewer: true });
  const stub = bindings.WORKSPACES.get(bindings.WORKSPACES.idFromName(`account:${f.owner}`));
  await evictDurableObject(stub);
  expect(await workspace(bindings, f.owner, { op: 'reviewer_status' })).toMatchObject({ repo_id: f.repo, expires, limit_microusd: 50_000_000, trial_limit_microusd: 5_000_000 });
  for (const change of [{ repo_id: 'foreign' }, { expires: expires + 1 }])
    await expect(workspace(bindings, f.owner, { op: 'reviewer_configure', repo_id: f.repo, expires, ...change })).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
  const repeated = await api(f.scoped, '/api/admin/reviewer/provision', '', { username: f.owner }, true);
  expect(await repeated.json()).toMatchObject({ repo_id: f.repo, budget_microusd: 50_000_000 });
  for (const path of ['/api/reviewer', '/api/settings', '/api/repositories']) {
    const response = await api(f.scoped, path, f.cookie);
    expect(response.status).toBe(200);
    const body = await response.text();
    for (const key of testKeys) expect(body).not.toContain(key);
    expect(body).not.toContain('ciphertext');
  }
  const records = await runInDurableObject(stub, (_instance, state) => [...state.storage.sql.exec('SELECT payload FROM workspace_records')]);
  for (const key of testKeys) expect(JSON.stringify(records)).not.toContain(key);
});

it('blocks arbitrary reviewer mutations and confines permitted review actions to its sandbox', async () => {
  const f = await readyReviewer();
  const before = await ledger(bindings, f.repo, { op: 'snapshot' });
  for (const path of [`/api/repos/${f.repo}/start_run`, `/api/repos/${f.repo}/update_policy`,
    `/api/repos/${f.repo}/grants`, '/api/settings/providers/codex', '/api/projects',
    '/api/repos/foreign/accept', '/api/repos/foreign/cancel_run', '/api/repos/foreign/resync_repository']) {
    expect((await api(f.scoped, path, f.cookie, { id: 'unapproved', key: 'attacker-key' })).status, path).toBe(403);
  }
  expect((await ledger(bindings, f.repo, { op: 'snapshot' })).seq).toBe(before.seq);
  expect((await workspace(bindings, f.owner, { op: 'settings' })).providers).toHaveLength(2);
  // Invalid domain input proves accept reaches the ledger rather than the guard.
  const accept = await api(f.scoped, `/api/repos/${f.repo}/accept`, f.cookie, { candidate_id: 'absent' });
  expect(accept.status).toBe(409);
  expect((await accept.json<Json>()).error.message).not.toContain('Reviewer access permits');
  const trial = await api(f.scoped, '/api/reviewer/trial', f.cookie, { request_id: 'trial-cancel-12345678' });
  expect(trial.status).toBe(200);
  const run = await trial.json<Json>();
  // Fake Container stop RPC; cancellation itself goes through the real ledger.
  f.scoped.EXECUTIONS = { idFromName: (name: string) => name, get: () => ({ stop: async () => {} }) } as unknown as typeof f.scoped.EXECUTIONS;
  expect((await api(f.scoped, `/api/repos/${f.repo}/cancel_run`, f.cookie, { run_id: run.run_id })).status).toBe(200);
  const remote = { [Symbol.dispose]() {}, info: async () => ({ defaultBranch: 'main' }), log: async () => [{ hash: 'a'.repeat(40) }] };
  const recoveryEnv = { ...f.scoped, ARTIFACTS: { get: async () => remote } } as unknown as typeof f.scoped;
  // Simulate an already-observed remote conflict in durable state, then exercise
  // the real owner CAS recovery command with fake Artifacts HEAD readback.
  await runInDurableObject(bindings.REPOSITORIES.get(bindings.REPOSITORIES.idFromName(f.repo)), (_instance, state) => {
    state.storage.sql.exec("UPDATE repository SET payload=json_set(payload,'$.status','blocked') WHERE id='repo'");
  });
  const status = await ledger(bindings, f.repo, { op: 'repository_status' });
  const recovered = await api(recoveryEnv, `/api/repos/${f.repo}/resync_repository`, f.cookie, { expected_version: status.version, expected_pending: null });
  expect(recovered.status).toBe(200);
  expect(await recovered.json()).toMatchObject({ status: 'ready', head_commit: 'a'.repeat(40) });
});

it('creates exactly one fixed two-agent $5 trial on concurrent replay and rejects another active trial', async () => {
  const f = await readyReviewer();
  expect((await api(f.scoped, '/api/reviewer/trial', f.cookie, {})).status).toBe(400);
  const body = { request_id: 'trial-replay-12345678', agents: [{ provider: 'codex', model: 'expensive' }], intent: 'attacker brief', budget: 999 };
  const responses = await Promise.all([1, 2, 3].map(() => api(f.scoped, '/api/reviewer/trial', f.cookie, body)));
  expect(responses.map(r => r.status)).toEqual([200, 200, 200]);
  const values = await Promise.all(responses.map(r => r.json<Json>()));
  expect(new Set(values.map(v => v.run_id)).size).toBe(1);
  const snapshot = await ledger(bindings, f.repo, { op: 'snapshot' });
  expect(snapshot.runs).toHaveLength(1);
  expect(snapshot.executions).toHaveLength(2);
  const run = snapshot.runs[0];
  expect(run.mode).toBe('collaborate');
  expect(run.intent).toContain('San Jose');
  expect(run.intent).not.toContain('attacker');
  expect(run.agents.map((a: Json) => [a.provider, a.model])).toEqual([['codex', 'gpt-5.6-luna'], ['claude', 'claude-sonnet-4-6']]);
  expect(run.model_budgets.reduce((sum: number, b: Json) => sum + b.spend_limit_microusd, 0)).toBe(5_000_000);
  const conflict = await api(f.scoped, '/api/reviewer/trial', f.cookie, { request_id: 'different-trial-12345678' });
  expect(conflict.status).toBe(409);
  expect((await conflict.json<Json>()).error.code).toBe('TRIAL_ACTIVE');
  await evictDurableObject(bindings.REPOSITORIES.get(bindings.REPOSITORIES.idFromName(f.repo)));
  expect((await api(f.scoped, '/api/reviewer/trial', f.cookie, body)).status).toBe(200);
  expect((await ledger(bindings, f.repo, { op: 'snapshot' })).runs).toHaveLength(1);
});

it('isolates tenants and serializes concurrent reservations at the durable $50 limit', async () => {
  const alice = await readyReviewer();
  const bob = await reviewerFixture('review_bob');
  expect(bob.repo).not.toBe(alice.repo);
  expect((await api(alice.scoped, `/api/repos/${alice.repo}/snapshot`, bob.cookie)).status).toBe(403);
  expect((await api(bob.scoped, '/api/reviewer', bob.cookie)).status).toBe(200);
  await workspace(bindings, alice.owner, { op: 'budget_reserve', id: 'seed-one', amount: 20_000_000 });
  await workspace(bindings, alice.owner, { op: 'budget_reserve', id: 'seed-two', amount: 20_000_000 });
  const attempts = await Promise.allSettled(['last-a', 'last-b'].map(id => workspace(bindings, alice.owner, { op: 'budget_reserve', id, amount: 10_000_000 })));
  expect(attempts.filter(a => a.status === 'fulfilled')).toHaveLength(1);
  expect(attempts.find(a => a.status === 'rejected')).toMatchObject({ reason: { code: 'BUDGET_EXHAUSTED' } });
  const winner = attempts[0].status === 'fulfilled' ? 'last-a' : 'last-b';
  await evictDurableObject(bindings.WORKSPACES.get(bindings.WORKSPACES.idFromName(`account:${alice.owner}`)));
  await workspace(bindings, alice.owner, { op: 'budget_reserve', id: winner, amount: 10_000_000 });
  expect((await workspace(bindings, alice.owner, { op: 'budget_status' })).charged).toBe(50_000_000);
  expect((await workspace(bindings, bob.owner, { op: 'budget_status' })).charged).toBe(0);
});

it('recovers a lost start_run acknowledgement and replays an old request after cancellation without duplicating work', async () => {
  const f = await readyReviewer();
  const real = f.scoped.REPOSITORIES;
  let lost = false;
  // Only transport is intercepted: start_run really commits to Rust DO SQLite.
  const scoped = { ...f.scoped, REPOSITORIES: { idFromName: (name: string) => real.idFromName(name),
    get: (id: DurableObjectId) => ({ fetch: async (url: string, options: RequestInit) => {
      const command = JSON.parse(String(options.body));
      const response = await real.get(id).fetch(url, options);
      if (command.op === 'start_run' && response.ok && !lost) {
        lost = true;
        await response.body?.cancel();
        throw new Error('Simulated lost committed start_run acknowledgement');
      }
      return response;
    } }) } } as unknown as typeof f.scoped;
  const request = { request_id: 'lost-ack-trial-12345678' };
  const first = await api(scoped, '/api/reviewer/trial', f.cookie, request);
  expect(first.status).toBe(200);
  expect(lost).toBe(true);
  const run = await first.json<Json>();
  expect((await ledger(bindings, f.repo, { op: 'snapshot' })).runs).toHaveLength(1);
  scoped.EXECUTIONS = { idFromName: (name: string) => name, get: () => ({ stop: async () => {} }) } as unknown as typeof scoped.EXECUTIONS;
  expect((await api(scoped, `/api/repos/${f.repo}/cancel_run`, f.cookie, { run_id: run.run_id })).status).toBe(200);
  const next = await api(scoped, '/api/reviewer/trial', f.cookie, { request_id: 'next-trial-12345678' });
  expect(next.status).toBe(200);
  const newRun = await next.json<Json>();
  expect(newRun.run_id).not.toBe(run.run_id);
  const replay = await api(scoped, '/api/reviewer/trial', f.cookie, request);
  expect(replay.status).toBe(200);
  expect((await replay.json<Json>()).run_id).toBe(run.run_id);
  expect((await workspace(bindings, f.owner, { op: 'reviewer_status' })).active_trial).toBe(newRun.run_id);
  expect((await ledger(bindings, f.repo, { op: 'snapshot' })).runs).toHaveLength(2);
});
