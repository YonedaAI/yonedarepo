import { describe, expect, it } from 'vitest';
import { resolveAdaptiveApproval } from '../../cloudflare/worker/adaptive-approval';

const pool = [
  { id: 'codex', provider: 'codex', model: 'gpt-5.6-luna', version: 1 },
  { id: 'glm', provider: 'zai', model: 'glm-5.3-flash', version: 2 },
  { id: 'unknown', provider: 'zai', model: 'unpriced-custom', version: 1 },
];
const request = { adaptive_team: { version: 1, requested_agents: [{ connection: null, role: 'auto' }] } };
describe('trusted adaptive run approval', () => {
  it('keeps explicit extra agent preferences for the planner while starting only one seed', () => {
    const approved = resolveAdaptiveApproval({ adaptive_team: { version: 1, requested_agents: [
      { connection: 'codex', role: 'backend' }, { connection: 'glm', role: 'frontend' },
    ] } }, pool);
    expect(approved.agents).toHaveLength(1);
    expect(approved.adaptive_team.requested_agents).toHaveLength(2);
    expect(approved.agents[0]).toMatchObject({ connection: 'codex', role_hint: 'backend' });
  });
  it('keeps manual and comparison work fixed while sharing the workspace allowance', () => {
    const approved = resolveAdaptiveApproval({ ...request, mode: 'compare' }, pool);
    expect(approved.mode).toBe('compare');
    expect(approved.adaptive_team).toBeUndefined();
    expect(approved._workspace_spend).toBe(true);
    expect(approved.model_budgets).toHaveLength(1);
  });
  it('starts one cheap seed and freezes only priced saved models, without letting the browser supply the pool', () => {
    const approved = resolveAdaptiveApproval({ ...request, _approved_model_pool: [{ connection: 'forged' }], model_budgets: [] }, pool);
    expect(approved.agents).toHaveLength(1);
    expect(approved.agents[0].connection).toBe('glm');
    expect(approved._approved_model_pool.map((p: { connection: string }) => p.connection)).toEqual(['glm', 'codex']);
    expect(approved.model_budgets).toHaveLength(2);
    expect(approved.autonomy_policy.enabled).toBe(true);
  });
  it('respects a chosen saved model and role while rejecting deleted or unpriced choices', () => {
    const selected = { adaptive_team: { version: 1, requested_agents: [{ connection: 'codex', role: 'backend' }] } };
    expect(resolveAdaptiveApproval(selected, pool).agents[0]).toMatchObject({ connection: 'codex', role_hint: 'backend' });
    expect(() => resolveAdaptiveApproval({ adaptive_team: { version: 1, requested_agents: [{ connection: 'unknown', role: 'auto' }] } }, pool)).toThrow();
    expect(() => resolveAdaptiveApproval({ adaptive_team: { version: 1, requested_agents: [{ connection: 'gone', role: 'auto' }] } }, pool)).toThrow();
  });
  it('rejects unsafe bounds and unknown roles rather than silently selecting a different intent', () => {
    expect(() => resolveAdaptiveApproval({ adaptive_team: { version: 2, requested_agents: [] } }, pool)).toThrow();
    expect(() => resolveAdaptiveApproval({ adaptive_team: { version: 1, requested_agents: [{ connection: null, role: 'publisher' }] } }, pool)).toThrow();
    expect(() => resolveAdaptiveApproval(request, [])).toThrow();
  });
  it('gives each sandbox agent a stock CLI its model can run, and refuses any other pair', () => {
    const sonnet = { id: 'sonnet', provider: 'claude', model: 'claude-sonnet-5-5', version: 1 };
    const compare = { ...request, mode: 'compare' };
    // Every provider has a sandbox CLI now (Codex CLI for OpenAI): Auto still takes the cheaper.
    for (const marker of [{}, { runtime: 'sandbox-cli-v1' }, { workspace_transport: 'sandbox-cli-v1' }])
      expect(resolveAdaptiveApproval({ ...compare, ...marker }, [pool[0], sonnet]).agents[0].connection).toBe('codex');
    const chosen = (connection: string, cli?: string, runtime: object = { runtime: 'sandbox-cli-v1' }) => ({
      mode: 'compare',
      ...runtime,
      adaptive_team: { version: 1, requested_agents: [{ connection: 'glm', role: 'builder' }, { connection, role: 'builder', ...(cli ? { cli } : {}) }] },
    });
    const approved = resolveAdaptiveApproval(chosen('codex', 'opencode'), pool).agents;
    // Unchosen, the ledger freezes the provider's default CLI.
    expect(approved.map((agent: { cli?: string }) => agent.cli)).toEqual([undefined, 'opencode']);
    const refusal = (body: object) => {
      try {
        resolveAdaptiveApproval(body, pool);
      } catch (error) {
        return (error as { code?: string }).code;
      }
    };
    // Claude Code speaks only Anthropic Messages; Codex CLI only OpenAI Responses.
    expect(refusal(chosen('codex', 'claude'))).toBe('SANDBOX_HARNESS');
    expect(refusal(chosen('glm', 'codex'))).toBe('SANDBOX_HARNESS');
    expect(refusal(chosen('glm', 'aider'))).toBe('SANDBOX_HARNESS');
    expect(refusal(chosen('codex', 'codex', {}))).toBe('INVALID_INPUT');
  });
  it('retains saved billing routing and bounded priced budgets for every allowed group', () => {
    const approved = resolveAdaptiveApproval(request, [{ ...pool[1], routing: { plan: 'api_credits' } }]);
    expect(approved.agents[0].routing).toEqual({ plan: 'api_credits' });
    expect(approved.model_budgets[0]).toMatchObject({ max_requests: 144, max_output_tokens: 4096, max_execution_ms: 600000, spend_limit_microusd: 50000000 });
  });
});
