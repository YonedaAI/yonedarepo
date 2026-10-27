import { describe, expect, it } from 'vitest';
import { resolveRunRoster } from '../../cloudflare/worker/run-roster';

const pool = [
  { id: 'codex', provider: 'codex', model: 'gpt-5.6-luna', version: 1 },
  { id: 'glm', provider: 'zai', model: 'glm-5.3-flash', version: 2 },
  { id: 'unknown', provider: 'zai', model: 'unpriced-custom', version: 1 },
];
const request = { adaptive_team: { version: 1, requested_agents: [{ connection: null, role: 'auto' }] } };
describe('trusted run roster approval', () => {
  it('keeps manual and comparison work fixed while sharing the workspace allowance', () => {
    const approved = resolveRunRoster({ ...request, mode: 'compare' }, pool);
    expect(approved.mode).toBe('compare');
    expect(approved.adaptive_team).toBeUndefined();
    expect(approved._workspace_spend).toBe(true);
    expect(approved.model_budgets).toHaveLength(1);
  });
  it('respects a chosen saved model and role while rejecting deleted or unpriced choices', () => {
    const selected = { adaptive_team: { version: 1, requested_agents: [{ connection: 'codex', role: 'backend' }] } };
    expect(resolveRunRoster(selected, pool).agents[0]).toMatchObject({ connection: 'codex', role_hint: 'backend' });
    expect(() => resolveRunRoster({ adaptive_team: { version: 1, requested_agents: [{ connection: 'unknown', role: 'auto' }] } }, pool)).toThrow();
    expect(() => resolveRunRoster({ adaptive_team: { version: 1, requested_agents: [{ connection: 'gone', role: 'auto' }] } }, pool)).toThrow();
  });
  it('rejects unsafe bounds and unknown roles rather than silently selecting a different intent', () => {
    expect(() => resolveRunRoster({ adaptive_team: { version: 2, requested_agents: [] } }, pool)).toThrow();
    expect(() => resolveRunRoster({ adaptive_team: { version: 1, requested_agents: [{ connection: null, role: 'publisher' }] } }, pool)).toThrow();
    expect(() => resolveRunRoster(request, [])).toThrow();
  });
  it('gives each sandbox agent a stock CLI its model can run, and refuses any other pair', () => {
    const sonnet = { id: 'sonnet', provider: 'claude', model: 'claude-sonnet-5-5', version: 1 };
    const compare = { ...request, mode: 'compare' };
    // Every provider has a sandbox CLI now (Codex CLI for OpenAI): Auto still takes the cheaper.
    for (const marker of [{}, { runtime: 'sandbox-cli-v1' }, { workspace_transport: 'sandbox-cli-v1' }])
      expect(resolveRunRoster({ ...compare, ...marker }, [pool[0], sonnet]).agents[0].connection).toBe('codex');
    const chosen = (connection: string, cli?: string, runtime: object = { runtime: 'sandbox-cli-v1' }) => ({
      mode: 'compare',
      ...runtime,
      adaptive_team: { version: 1, requested_agents: [{ connection: 'glm', role: 'builder' }, { connection, role: 'builder', ...(cli ? { cli } : {}) }] },
    });
    const approved = resolveRunRoster(chosen('codex', 'opencode'), pool).agents;
    // Unchosen, the ledger freezes the provider's default CLI.
    expect(approved.map((agent: { cli?: string }) => agent.cli)).toEqual([undefined, 'opencode']);
    const refusal = (body: object) => {
      try {
        resolveRunRoster(body, pool);
      } catch (error) {
        return (error as { code?: string }).code;
      }
    };
    // Claude Code speaks only Anthropic Messages; Codex CLI only OpenAI Responses.
    expect(refusal(chosen('codex', 'claude'))).toBe('SANDBOX_HARNESS');
    expect(refusal(chosen('glm', 'codex'))).toBe('SANDBOX_HARNESS');
    expect(refusal(chosen('glm', 'aider'))).toBe('SANDBOX_HARNESS');
    // Every run is a sandbox run, so a request without the marker takes a CLI too.
    expect(refusal(chosen('codex', 'codex', {}))).toBeUndefined();
  });
  it('retains saved billing routing and bounded priced budgets for every allowed group', () => {
    const approved = resolveRunRoster(request, [{ ...pool[1], routing: { plan: 'api_credits' } }]);
    expect(approved.agents[0].routing).toEqual({ plan: 'api_credits' });
    expect(approved.model_budgets[0]).toMatchObject({ max_requests: 144, max_output_tokens: 4096, max_execution_ms: 600000, spend_limit_microusd: 50000000 });
  });
});
