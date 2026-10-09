import { expect, it } from 'vitest';
import { checkLedger, checkRuntime } from '../../cloudflare/worker/runtime';

it('refuses automatic planning on an older image before model calls', () => {
  const job = { kind: 'agent', payload: { team_planning: true } };
  expect(() => checkRuntime({ protocol: 2 }, job)).toThrow('team planning');
  expect(() => checkRuntime({ protocol: 2, capabilities: { team_planning: 1 } }, job)).not.toThrow();
});

it('requires automatic planning ledger support while preserving explicit plans', () => {
  const snapshot = { capabilities: { artifact_reads: 2, collaborative_runs: 1 } };
  expect(() => checkLedger(snapshot, { mode: 'collaborate' })).toThrow('updating');
  expect(() => checkLedger(snapshot, { mode: 'collaborate', team: { version: 1 } })).not.toThrow();
  expect(() => checkLedger({ capabilities: { ...snapshot.capabilities, team_planning: 1 } }, { mode: 'collaborate' })).not.toThrow();
});
