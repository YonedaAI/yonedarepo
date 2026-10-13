import { expect, it } from 'vitest';
import { checkLedger, checkRuntime } from '../../cloudflare/worker/runtime';
import { failureCode } from '../../cloudflare/worker/logging';

it('rejects an old ledger before it can silently drop trusted shared accounting', () => {
  const old = { capabilities: { artifact_reads: 2 } };
  expect(() => checkLedger(old, { _workspace_spend: true })).toThrow('updating');
  expect(() => checkLedger({ capabilities: { ...old.capabilities, workspace_spend: 1 } }, { _workspace_spend: true })).not.toThrow();
  expect(() => checkLedger(old)).not.toThrow();
});

it('labels an old adaptive runtime as a rollout error and does not affect legacy jobs', () => {
  const job = { kind: 'agent', payload: { run: { adaptive_team: { version: 1 } } } };
  try { checkRuntime({ protocol: 2 }, job); throw new Error('accepted'); }
  catch (e) { expect(e).toMatchObject({ code: 'RUNTIME_UPDATING' }); }
  expect(() => checkRuntime({ protocol: 2, capabilities: { adaptive_teams: 1 } }, job)).not.toThrow();
  expect(() => checkRuntime({ protocol: 2 }, { kind: 'agent', payload: {} })).not.toThrow();
});

it('preserves safe workspace error codes without logging arbitrary provider text', () => {
  expect(failureCode({ code: 'WORKSPACE_SPEND_EXHAUSTED' })).toBe('WORKSPACE_SPEND_EXHAUSTED');
  expect(failureCode({ code: 'WORKSPACE_TRANSITION_BUSY' })).toBe('WORKSPACE_TRANSITION_BUSY');
  expect(failureCode({ code: 'secret arbitrary text' })).toBe('UNKNOWN');
});
