import { env } from 'cloudflare:workers';
import { reset } from 'cloudflare:test';
import { afterEach, expect, it } from 'vitest';
import { guardContextAccess, sanitizeContextResponse } from '../../cloudflare/worker/context-policy';
import { hostedMcp } from '../../cloudflare/worker/hosted-mcp';
import { remoteTool } from '../../cloudflare/worker/remote-tools';
import { sitePolicy } from '../../cloudflare/worker/site-policy';
import { ledger } from '../../cloudflare/worker/storage';
import type { Env, Json, Principal } from '../../cloudflare/worker/types';

const bindings = env as unknown as Env;
const repo = 'study-repo';
const agents = [{ provider: 'codex', model: 'gpt-5.6-luna', strategy: 'minimal' }];
const principal: Principal = { workspace: '_admin', role: 'agent', grant: { id: 'study-grant', repo, scope: 'contribute' } };
const identity = { _workspace: '_admin', _grant: 'study-grant' };
const canary = 'HISTORICAL_CANARY_preserve_accessible_registration';
const arms = ['source_only', 'plain_notes', 'graph'] as const;
afterEach(reset);

async function setup(arm: typeof arms[number]) {
  await ledger(bindings, repo, { op: 'init', id: repo, name: 'Isolated study', workspace: '_admin', remote: { namespace: 'yoneda-test', name: repo }, commit: 'a'.repeat(40), policy: sitePolicy });
  await ledger(bindings, repo, { op: 'start_run', id: 'historical', intent: 'Earlier website', agents });
  const note = await ledger(bindings, repo, { op: 'context_publish', record: { id: 'context:historical-note', kind: 'constraint', statement: canary, purpose: 'Preserve keyboard access', intent_id: 'intent:historical', links: [] } });
  await ledger(bindings, repo, { op: 'cancel_run', run_id: 'historical' });
  const config = { id: 'trial-study', case: 'website_update', arm, corpus: [note.id] };
  const study = await ledger(bindings, repo, { op: 'configure_context_study', _workspace: '_admin', context_study: config });
  expect(study.records).toEqual([note]);
  await ledger(bindings, repo, { op: 'start_run', id: 'trial', intent: 'Improve registration', agents, context: [note.id] });
  const job = await ledger(bindings, repo, { op: 'claim', job_id: 'job:trial:agent-1' });
  return { note, config, job, scope: { repo_id: repo, job, supervisor: 'unused-test-supervisor', model_calls: 0, created_at: Date.now() } };
}

it.each(['source_only', 'plain_notes'] as const)('%s rejects every historical retrieval surface before returning data', async arm => {
  await setup(arm);
  for (const tool of ['context_search', 'context_get', 'graph', 'why', 'decision', 'artifact_get']) {
    const args = { id: 'context:historical-note', query: canary, path: 'index.html', commit: 'a'.repeat(40) };
    await expect(guardContextAccess(bindings, repo, identity, tool, args)).rejects.toThrow('CONTEXT_STUDY_RESTRICTED');
    await expect(remoteTool(bindings, principal, repo, tool, args, 'https://yoneda')).rejects.toThrow('CONTEXT_STUDY_RESTRICTED');
  }
  const usage = await ledger(bindings, repo, { op: 'context_usage', ...identity });
  expect(usage.counts.read_calls).toBe(0);
});

it.each(arms)('%s sanitizes initial and status responses recursively, with notes only in the flat arm', async arm => {
  const { note, config, scope, job } = await setup(arm);
  const payload = {
    context: [note], context_records: [note], runs: [{ context_study: { ...config, records: [note] } }],
    nested: [{ payload: { run: { context_study: { ...config, records: [note] }, context_records: [note] }, artifacts: [note], decisions: [note] } }],
    execution: { id: job.payload.execution.id, context: [note.id] },
  };
  for (const tool of ['repo_context', 'execution_status', 'attempt_begin', 'attempt_status', 'delegation_status']) {
    const value = await sanitizeContextResponse(bindings, repo, identity, tool, payload);
    expect(JSON.stringify(value)).not.toContain('context_study');
    expect(value.nested[0].payload.run.context_records).toEqual([]);
    expect(value.nested[0].payload.artifacts).toEqual([]);
    expect(value.nested[0].payload.decisions).toEqual([]);
    expect(value.execution.context).toEqual([]);
    if (arm === 'plain_notes') expect(value.plain_notes).toEqual([note]);
    else expect(JSON.stringify(value)).not.toContain(canary);
  }
  for (const tool of ['repo_context', 'execution_status', 'delegation_status']) {
    const value = await (await hostedMcp(bindings, scope, { name: tool, arguments: {} })).json<Json>();
    expect(JSON.stringify(value)).not.toContain('context_study');
    if (value.run) expect(value.run.context_records).toEqual([]);
    if (arm === 'plain_notes') expect(value.plain_notes).toEqual([note]);
    else expect(JSON.stringify(value)).not.toContain(canary);
  }
  const remote = await remoteTool(bindings, principal, repo, 'repo_context', {}, 'https://yoneda');
  expect(remote.runs).toEqual([]);
  expect(remote.context).toEqual([]);
  if (arm === 'plain_notes') expect(remote.plain_notes).toEqual([note]);
  else expect(JSON.stringify(remote)).not.toContain(canary);
  const fakeRemote = { [Symbol.dispose]() {}, fork: async () => ({ token: 'test-capability' }), info: async () => ({}), listTokens: async () => ({ tokens: [] }), revokeToken: async () => true };
  const scoped = { ...bindings, ARTIFACTS: { get: async () => fakeRemote } } as unknown as Env;
  const attempt = await remoteTool(scoped, principal, repo, 'attempt_begin', { request_id: crypto.randomUUID(), intent: 'Continue the study' }, 'https://yoneda');
  const status = await remoteTool(scoped, principal, repo, 'attempt_status', { attempt_id: attempt.attempt_id }, 'https://yoneda');
  for (const value of [attempt, status]) {
    expect(JSON.stringify(value)).not.toContain('context_study');
    if (arm === 'plain_notes') expect(value.plain_notes).toEqual([note]);
    else expect(JSON.stringify(value)).not.toContain(canary);
  }
  const receipts = await ledger(bindings, repo, { op: 'context_usage', run_id: 'trial' });
  const opened = receipts.entries.flatMap((entry: Json) => entry.targets.map((target: Json) => target.id));
  expect(opened.includes(note.id)).toBe(arm === 'plain_notes');
});

it('graph permits explicit retrieval and records exact opened nodes without preloading the corpus', async () => {
  const { note } = await setup('graph');
  const value = await remoteTool(bindings, principal, repo, 'context_get', { id: note.id }, 'https://yoneda');
  expect(value).toEqual(note);
  const graph = await remoteTool(bindings, principal, repo, 'graph', { id: note.id, depth: 1 }, 'https://yoneda');
  expect(graph.nodes.some((node: Json) => node.id === note.id)).toBe(true);
  expect(JSON.stringify(graph)).not.toContain('context_study');
  const usage = await remoteTool(bindings, principal, repo, 'context_usage', {}, 'https://yoneda');
  expect(usage.version).toBe(1);
  expect(usage.counts.read_calls).toBe(2);
  expect(usage.coverage.status).toBe('partial');
  expect(usage.entries[0].targets[0]).toMatchObject({ id: note.id, authority: 'assertion' });
});

it.each(['source_only', 'plain_notes'] as const)('%s usage remains structured while withholding historical labels and records', async arm => {
  const { scope } = await setup(arm);
  await hostedMcp(bindings, scope, { name: 'repo_context', arguments: {} });
  const value = await (await hostedMcp(bindings, scope, { name: 'context_usage', arguments: {} })).json<Json>();
  expect(value.version).toBe(1);
  expect(value.run_id).toBe('trial');
  expect(value.coverage).toMatchObject({ status: 'restricted_by_study' });
  expect(typeof value.coverage.reason).toBe('string');
  expect(typeof value.coverage.activated_at).toBe('number');
  expect(value.counts).toEqual({ assigned: 0, returned: 0, opened: 0, cited: 0, checked: 0, read_calls: 0 });
  for (const field of ['entries', 'assigned', 'citations', 'checked']) expect(value[field]).toEqual([]);
  expect(value.has_more).toBe(false);
  expect(JSON.stringify(value)).not.toContain(canary);
});

it('rejects changing study configuration after a trial run, including after cancellation', async () => {
  const { config } = await setup('graph');
  await ledger(bindings, repo, { op: 'cancel_run', run_id: 'trial' });
  await expect(ledger(bindings, repo, { op: 'configure_context_study', _workspace: '_admin', context_study: { ...config, arm: 'source_only' } })).rejects.toThrow('frozen after the first trial run');
  expect((await ledger(bindings, repo, { op: 'repository_status' })).context_study.arm).toBe('graph');
});
