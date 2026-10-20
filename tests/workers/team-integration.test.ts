// Offline captures are synthetic; orchestration and receipts use the real Rust DO ledger.
import { env } from 'cloudflare:workers';
import { evictDurableObject, reset } from 'cloudflare:test';
import { afterEach, expect, it } from 'vitest';
import { hostedMcp } from '../../cloudflare/worker/hosted-mcp';
import { fetchRequest } from '../../cloudflare/worker/routes';
import { checkLedger, checkRuntime } from '../../cloudflare/worker/runtime';
import { ledger } from '../../cloudflare/worker/storage';
import type { Env, Json, Scope } from '../../cloudflare/worker/types';
import { platformCommit, platformProject } from './platform-fixture';
import { approvedLedger, finishSealed, withLineage } from './source-kit';

const bindings = env as unknown as Env;
const repo = 'offline-team';
let base = 'a'.repeat(40);
const repository = `platform/${repo}`;
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
  const project = await platformProject(bindings, 'alice', repo, { 'public/index.html': '<!doctype html>\n' },
    { version: 'team-v1', suite: 'commands-v1', environment: 'linux-node24-rust1.94-v1',
      required_checks: ['build'], build: { setup: [], checks: [{ name: 'build', argv: ['node', '--check', 'public/search.mjs'], timeout_seconds: 30 }] } });
  base = project.base.commit;
  await approvedLedger(bindings, repo)(request);
  return { cookie, ...project };
}
function scope(job: Json): Scope {
  return { repo_id: repo, job, supervisor: 'private-test-token', model_calls: 0, created_at: Date.now() };
}
async function captured(task: string, paths: string[], digest?: string,
  at: { commit: string; tree: string } = { commit: 'c'.repeat(40), tree: 'd'.repeat(40) }) {
  const job = await ledger(bindings, repo, { op: 'claim', job_id: `job:team:task:${task}` });
  if (task !== 'integrate') {
    const response = await hostedMcp(bindings, scope(job), { name: 'task_handoff', arguments: {
      summary: `Implemented ${task}`, interface_contract: `export ${task}`, references: ['intent:team'],
      job_id: 'forged', epoch: 999,
    } });
    expect((await response.json<Json>()).execution_id).toBe(`team:task:${task}`);
  }
  const registration = await finishSealed(bindings, repo, job);
  const capture = await ledger(bindings, repo, { op: 'claim', job_id: `capture:team:task:${task}` });
  await ledger(bindings, repo, { op: 'finish', job_id: capture.id, epoch: capture.epoch,
    result: withLineage(registration, { id: `captured-${task}`, revision: { repository, commit: at.commit },
      tree: at.tree, paths, summary: 'Synthetic captured fixture', diff: 'Synthetic diff',
      ...(digest ? { integration_digest: digest } : {}) }),
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
  const registration = await finishSealed(bindings, repo, active);
  const capture = await ledger(bindings, repo, { op: 'claim', job_id: 'capture:team:task:integrate' });
  const result = withLineage(registration, { id: 'integrated', revision: { repository, commit: 'e'.repeat(40) }, tree: 'f'.repeat(40), paths: ['public/search.mjs', 'public/rsvp.mjs', 'public/index.html'], summary: 'Integrated fixture', diff: 'Synthetic integrated diff' });
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

it('owner source inspection resolves only recorded exact captures and tree identities', async () => {
  const { cookie, platform } = await setup();
  const search = await platformCommit(platform, base, { 'public/search.mjs': 'export const search = () => [];\n' });
  await captured('search', ['public/search.mjs'], undefined, search);
  // A recorded output whose tree is not the commit's tree must never be served.
  await captured('rsvp', ['public/rsvp.mjs'], undefined, { commit: search.commit, tree: 'd'.repeat(40) });
  const read = (headers = { cookie }, task = 'search') => fetchRequest(new Request(`https://yoneda/api/repos/${repo}/team_source?run_id=team&task_id=${task}&repository=forged&commit=forged`, { headers }), bindings);
  expect((await read({ cookie: '' })).status).toBe(401);
  expect((await read(undefined, 'integrate')).status).toBe(404);
  const source = await read();
  expect(source.status).toBe(200);
  expect(source.headers.get('cache-control')).toBe('no-store');
  const body = await source.json<Json>();
  expect(body.revision).toEqual({ repository, commit: search.commit });
  expect(body.tree).toBe(search.tree);
  expect(JSON.stringify(body)).toContain('export const search');
  expect((await read(undefined, 'rsvp')).status).not.toBe(200);
});

it('fences old ledger and image versions before starting collaborative work', () => {
  expect(() => checkLedger({ capabilities: { artifact_reads: 2 } }, request)).toThrow('updating');
  const job = { kind: 'agent', payload: { execution: { team_task: 'assigned' } } };
  expect(() => checkRuntime({ protocol: 2 }, job)).toThrow('collaborative');
  expect(() => checkRuntime({ protocol: 2, capabilities: { collaborative_runs: 1 } }, job)).not.toThrow();
});
