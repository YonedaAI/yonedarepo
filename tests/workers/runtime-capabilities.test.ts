import { expect, it } from 'vitest';
import { checkLedger } from '../../cloudflare/worker/runtime';

it('refuses an explicit reasoning choice before a ledger can freeze it, while preserving Auto', () => {
  const snapshot = { capabilities: { artifact_reads: 2, adaptive_teams: 1, agent_limits: { min_root_agents: 1 } } };
  const request = { adaptive_team: { version: 1, requested_agents: [{ connection: 'saved', role: 'auto', reasoning_effort: 'high' }] } };
  expect(() => checkLedger(snapshot, request)).toThrow('reasoning');
  expect(() => checkLedger({ capabilities: { ...snapshot.capabilities, reasoning_effort: 1 } }, request)).not.toThrow();
  expect(() => checkLedger(snapshot, { adaptive_team: { version: 1, requested_agents: [{ connection: null, role: 'auto' }] } })).not.toThrow();
});

