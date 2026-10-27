import { expect, it } from 'vitest';
import { resolveRunRoster } from '../../cloudflare/worker/run-roster';
import { resolveFixedApproval } from '../../cloudflare/worker/fixed-run-approval';

const connections = [{ id: 'luna', provider: 'codex', model: 'gpt-5.6-luna', version: 1 }];

it('retains effort on fixed approvals and restricts Auto seeds without disabling explicit catalog models', () => {
  const fixed = resolveFixedApproval({ agents: [{ connection: 'luna', provider: 'codex', model: 'gpt-5.6-luna', strategy: 'Fixed', reasoning_effort: 'low' }] }, connections, 50000000);
  expect(fixed.agents[0].reasoning_effort).toBe('low');
  const modern = [{ id: 'sol', provider: 'codex', model: 'gpt-6.1-sol', version: 1 }];
  expect(() => resolveRunRoster({ adaptive_team: { version: 1, requested_agents: [{ connection: null, role: 'auto' }] } }, modern)).toThrow();
  expect(resolveRunRoster({ adaptive_team: { version: 1, requested_agents: [{ connection: 'sol', role: 'builder', reasoning_effort: 'max' }] } }, modern).agents[0]).toMatchObject({ connection: 'sol', reasoning_effort: 'max' });
  expect(() => resolveRunRoster({ adaptive_team: { version: 1, requested_agents: [{ connection: 'sol', role: 'builder', reasoning_effort: 'none' }] } }, modern)).toThrow();
});
