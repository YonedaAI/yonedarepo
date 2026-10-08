import { env } from 'cloudflare:workers';
import { evictDurableObject, reset } from 'cloudflare:test';
import { afterEach, expect, it } from 'vitest';
import { ledger } from '../../worker/storage';
import type { Env } from '../../worker/types';

const bindings = env as unknown as Env;
afterEach(async () => { await reset(); });
it('refuses a previous image for a general agent run and preserves the configured provider model', async () => {
  const {checkRuntime, modelForJob} = await import('../../worker/runtime');
  const job = {kind:'agent', model:'mimo-v2-flash', payload:{policy:{build:{checks:[]}},execution:{harness:'claude'}}};
  expect(() => checkRuntime({protocol:2,suites:['retry-contract-v2']},job)).toThrow();
  expect(() => checkRuntime({protocol:2,suites:['commands-v1']},job)).not.toThrow();
  expect(modelForJob(job,{codex:'gpt-5.6-luna',claude:'claude-sonnet-4-6'})).toBe('mimo-v2-flash');
});
it('persists concurrent general attempts and immutable typed context through eviction', async () => {
  const id = 'portfolio';
  const call = (command: Record<string, unknown>) => ledger(bindings, id, command);
  await call({ op: 'init', id, name: 'Portfolio', remote: {namespace: 'yoneda-test', name: 'portfolio'}, commit: 'a'.repeat(40), policy: { version: 'site-v1', suite: 'commands-v1', environment: 'linux-node24-rust1.94-v1', required_checks: ['html'], build: {setup: [], checks: [{name: 'html', argv: ['node', '--check', 'app.js'], timeout_seconds: 30}], static_dir: 'public'} } });
  await call({op: 'start_run', id: 'site', intent: 'Build a portfolio', criteria: ['Accessible'], agents: [{provider: 'mimo', model: 'mimo-v2-flash', strategy: 'simple'}, {provider: 'zai', model: 'glm-4.7-flash', strategy: 'editorial'}]});
  const s = await call({op: 'snapshot'});
  expect(s.executions).toHaveLength(2);
  expect(s.executions.every((e: {role: string}) => e.role === 'coding')).toBe(true);
  const claim = await call({op: 'claim', job_id: 'job:site:agent-1', models: {claude: 'expensive-override'}});
  expect(claim.model).toBe('mimo-v2-flash');
  const record = {id: 'context:mobile', kind: 'assumption', statement: 'Visitors use screen readers', purpose: 'Guide navigation', intent_id: 'intent:site', author: 'owner', verified: true};
  const result = await call({op: 'context_publish', record, job_id: claim.id, epoch: claim.epoch});
  expect(result.author).toBe('site:agent-1');
  expect(result.data.authority).toBe('assertion');
  expect(result.data.verified).toBeUndefined();
  await expect(call({op: 'context_publish', record, job_id: claim.id, epoch: claim.epoch})).rejects.toThrow('already exists');
  const stub = bindings.REPOSITORIES.get(bindings.REPOSITORIES.idFromName(id));
  await evictDurableObject(stub);
  const found = await call({op: 'context_search', query: 'screen readers', kind: 'assumption', limit: 1});
  expect(found.items.map((n: {id:string}) => n.id)).toEqual(['context:mobile']);
  expect(found.next_cursor).toBeNull();
});
