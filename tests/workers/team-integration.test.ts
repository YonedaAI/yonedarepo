// Offline captures are synthetic; orchestration and receipts use the real Rust DO ledger.
import { env } from 'cloudflare:workers';
import { evictDurableObject, reset } from 'cloudflare:test';
import { afterEach, expect, it } from 'vitest';
import { hostedMcp } from '../../cloudflare/worker/hosted-mcp';
import { fetchRequest } from '../../cloudflare/worker/routes';
import { checkLedger, checkRuntime } from '../../cloudflare/worker/runtime';
import { ledger } from '../../cloudflare/worker/storage';
import { teamAttemptSource } from '../../cloudflare/worker/team-source';
import type { Env, Json, Scope } from '../../cloudflare/worker/types';

const bindings = env as unknown as Env;
const repo = 'offline-team';
const base = 'a'.repeat(40);
afterEach(reset);
const request = {
  op: 'start_run', id: 'team', intent: 'Offline complementary team fixture', mode: 'collaborate',
  agents: [
    { provider: 'mimo', model: 'mimo-v2.6-flash', strategy: 'specialist' },
    { provider: 'zai', model: 'glm-5.3-flash', strategy: 'specialist' },
    { provider: 'mimo', model: 'mimo-v2.6-flash', strategy: 'integrator' },
  ],
  team: { version: 1, contract: 'Search and RSVP modules export independent interfaces.',
    integrator_agent: 2, integration_paths: ['public/index.html'], tasks: [
      { id: 'search', title: 'Search', instructions: 'Implement search', agent: 0, depends_on: [], write_paths: ['public/search.mjs'] },
      { id: 'rsvp', title: 'RSVP', instructions: 'Implement RSVP', agent: 1, depends_on: [], write_paths: ['public/rsvp.mjs'] },
    ] },
};
async function setup() {
  const signup = await bindings.SELF.fetch('https://yoneda/api/auth/signup', {
    method: 'POST', body: JSON.stringify({ username: 'alice', password: 'long team test password' }),
  });
  expect(signup.status).toBe(200);
  const cookie = signup.headers.get('set-cookie')!.split(';')[0];
  await ledger(bindings, repo, { op: 'init', id: repo, name: 'Offline team fixture', workspace: 'alice',
    remote: { namespace: 'yoneda-test', name: repo }, commit: base,
    policy: { version: 'team-v1', suite: 'commands-v1', environment: 'linux-node24-rust1.94-v1',
      required_checks: ['build'], build: { setup: [], checks: [{ name: 'build', argv: ['node', '--check', 'public/search.mjs'], timeout_seconds: 30 }] } },
  });
  await ledger(bindings, repo, request);
  return cookie;
}
function scope(job: Json): Scope {
  return { repo_id: repo, job, supervisor: 'private-test-token', model_calls: 0, created_at: Date.now() };
}
async function captured(task: string, paths: string[], digest?: string) {
  const job = await ledger(bindings, repo, { op: 'claim', job_id: `job:team:task:${task}` });
  if (task !== 'integrate') {
    const response = await hostedMcp(bindings, scope(job), { name: 'task_handoff', arguments: {
      summary: `Implemented ${task}`, interface_contract: `export ${task}`, references: ['intent:team'],
      job_id: 'forged', epoch: 999,
    } });
    expect((await response.json<Json>()).execution_id).toBe(`team:task:${task}`);
  }
  await ledger(bindings, repo, { op: 'finish', job_id: job.id, epoch: job.epoch, result: { workspace: 'b'.repeat(64) } });
  const capture = await ledger(bindings, repo, { op: 'claim', job_id: `capture:team:task:${task}` });
  await ledger(bindings, repo, { op: 'finish', job_id: capture.id, epoch: capture.epoch,
    result: { id: `captured-${task}`, revision: { repository: `yoneda-test/${task}`, commit: 'c'.repeat(40) },
      tree: 'd'.repeat(40), paths, summary: 'Synthetic captured fixture', diff: 'Synthetic diff',
      ...(digest ? { integration_digest: digest } : {}) },
  });
  return job;
}
it('captures specialists before integration, records exact retrieved handoffs, checks only the integrated candidate and survives eviction', async () => {
  await setup();
  await captured('search', ['public/search.mjs']);
  let snapshot = await ledger(bindings, repo, { op: 'snapshot' });
  expect(snapshot.team_tasks.find((t: Json) => t.task_id === 'integrate').status).toBe('blocked');
  expect(snapshot.candidates).toEqual([]);
  await captured('rsvp', ['public/rsvp.mjs']);
  const active = await ledger(bindings, repo, { op: 'claim', job_id: 'job:team:task:integrate' });
  const context = await (await hostedMcp(bindings, scope(active), { name: 'team_context', arguments: { job_id: 'forged' } })).json<Json>();
  expect(context.handoffs).toHaveLength(2);
  expect(context.handoffs.every((h: Json) => h.authority === 'captured_revision')).toBe(true);
  const manifest = await (await hostedMcp(bindings, scope(active), { name: 'integration_request' })).json<Json>();
  expect(manifest.digest).toBe(active.payload.integration_digest);
  expect(manifest.manifest.inputs.map((i: Json) => i.task_id)).toEqual(['rsvp', 'search']);
  await evictDurableObject(bindings.REPOSITORIES.get(bindings.REPOSITORIES.idFromName(repo)));
  const usage = await ledger(bindings, repo, { op: 'context_usage', run_id: 'team' });
  expect(usage.entries.some((e: Json) => e.execution_id === 'team:task:integrate' && e.targets.some((t: Json) => t.id === context.handoffs[0].id))).toBe(true);
  expect(usage.entries.some((e: Json) => e.targets.some((t: Json) => t.id === manifest.manifest_record.id))).toBe(true);
  await ledger(bindings, repo, { op: 'finish', job_id: active.id, epoch: active.epoch, result: { workspace: 'b'.repeat(64) } });
  const capture = await ledger(bindings, repo, { op: 'claim', job_id: 'capture:team:task:integrate' });
  const result = { id: 'integrated', revision: { repository: 'yoneda-test/integrated', commit: 'e'.repeat(40) }, tree: 'f'.repeat(40), paths: ['public/search.mjs', 'public/rsvp.mjs', 'public/index.html'], summary: 'Integrated fixture', diff: 'Synthetic integrated diff' };
  await expect(ledger(bindings, repo, { op: 'finish', job_id: capture.id, epoch: capture.epoch, result })).rejects.toThrow('manifest');
  await ledger(bindings, repo, { op: 'finish', job_id: capture.id, epoch: capture.epoch, result: { ...result, integration_digest: manifest.digest } });
  snapshot = await ledger(bindings, repo, { op: 'snapshot' });
  expect(snapshot.candidates).toHaveLength(1);
  const evaluation = await ledger(bindings, repo, { op: 'claim', job_id: 'evaluate:integrated' });
  await ledger(bindings, repo, { op: 'verify_finish', job_id: evaluation.id, epoch: evaluation.epoch, evidence: 'f'.repeat(64), report: { suite: 'commands-v1', environment: 'linux-node24-rust1.94-v1', setup: [], commands: [{ name: 'build', output: { exit: 0 } }] } });
  await ledger(bindings, repo, { op: 'accept', request_id: 'release-team', candidate: 'integrated', expected_commit: base, expected_version: 0, rationale: 'Synthetic integration acceptance' });
  expect((await ledger(bindings, repo, { op: 'snapshot' })).runs[0].status).toBe('accepted');
  await expect(hostedMcp(bindings, scope(active), { name: 'team_context' })).rejects.toThrow();
});

it('owner source inspection and broker assembly resolve only recorded exact captures and tree identities', async () => {
  const cookie = await setup();
  const job = await captured('search', ['public/search.mjs']);
  const reads: string[] = [];
  let tree = 'd'.repeat(40);
  const remote = { [Symbol.dispose]() {}, readCommit: async (commit: string) => { reads.push(commit); return { treeHash: tree }; },
    readTree: async () => [{ name: 'search.mjs', type: 'blob', hash: 'e'.repeat(40) }], readBlob: async () => new Blob(['export const search = () => [];']) };
  const scoped = { ...bindings, ARTIFACTS: { get: async (name: string) => { reads.push(name); return remote; } } } as unknown as Env;
  const read = (headers = { cookie }, task = 'search') => fetchRequest(new Request(`https://yoneda/api/repos/${repo}/team_source?run_id=team&task_id=${task}&repository=forged&commit=forged`, { headers }), scoped);
  expect((await read({ cookie: '' })).status).toBe(401);
  expect((await read(undefined, 'rsvp')).status).toBe(404);
  expect(reads).toEqual([]);
  const source = await read();
  expect(source.status).toBe(200);
  expect(source.headers.get('cache-control')).toBe('no-store');
  expect((await source.json<Json>()).revision).toEqual({ repository: 'yoneda-test/search', commit: 'c'.repeat(40) });
  expect(reads).toEqual(['search', 'c'.repeat(40)]);
  const snapshot = await ledger(bindings, repo, { op: 'snapshot' });
  const input = snapshot.team_tasks.find((t: Json) => t.task_id === 'search').output;
  const integration = { kind: 'agent', payload: { execution: { team_task: 'task' }, team_inputs: [input] } };
  expect((await teamAttemptSource(scoped, integration, 0)).input).toEqual(input);
  await expect(teamAttemptSource(scoped, integration, 1)).rejects.toThrow('missing');
  await expect(teamAttemptSource(scoped, job, -1)).rejects.toThrow('index');
  tree = '0'.repeat(40);
  await expect(teamAttemptSource(scoped, integration, 0)).rejects.toThrow('tree');
});

it('fences old ledger and image versions before starting collaborative work', () => {
  expect(() => checkLedger({ capabilities: { artifact_reads: 2 } }, request)).toThrow('updating');
  const job = { kind: 'agent', payload: { execution: { team_task: 'assigned' } } };
  expect(() => checkRuntime({ protocol: 2 }, job)).toThrow('collaborative');
  expect(() => checkRuntime({ protocol: 2, capabilities: { collaborative_runs: 1 } }, job)).not.toThrow();
});
