// Adapter approval only: a guide's model mix resolves to saved connections or fails before start.
import { describe, expect, it } from 'vitest';
import { resolveAdaptiveApproval } from '../../cloudflare/worker/adaptive-approval';

const saved = [
  { id: 'codex', provider: 'codex', model: 'gpt-5.6-luna' },
  { id: 'glm', provider: 'zai', model: 'glm-5.3-flash' },
  { id: 'sonnet', provider: 'claude', model: 'claude-sonnet-5-5' },
];
const model_mix = {
  specialists: { provider: 'codex', model: 'gpt-5.6-luna' },
  coordination: { provider: 'zai', model: 'glm-5.3-flash' },
};
const rows = [{ connection: null, role: 'backend' }, { connection: null, role: 'frontend' }];
const automatic = { mode: 'collaborate', adaptive_team: { version: 1, requested_agents: rows, model_mix } };
const team = {
  version: 1, contract: 'tasks API', integrator_agent: 2, integration_paths: ['public/'],
  tasks: [
    { id: 'behavior', title: 'B', instructions: 'B', agent: 0, depends_on: [], write_paths: ['public/tasks.mjs'] },
    { id: 'interface', title: 'I', instructions: 'I', agent: 1, depends_on: [], write_paths: ['public/app.mjs'] },
  ],
};

describe('approved guide model mix', () => {
  it('seeds planning on the coordination model and freezes the specialist connection', () => {
    const approved = resolveAdaptiveApproval(automatic, saved);
    expect(approved.agents).toHaveLength(1);
    expect(approved.agents[0]).toMatchObject({ connection: 'glm', provider: 'zai' });
    expect(approved.adaptive_team).toEqual({ version: 1, requested_agents: rows, specialist_connection: 'codex' });
    expect(approved.model_budgets.map((b: { model: string }) => b.model)).toContain('gpt-5.6-luna');
  });
  it('gives a fixed plan specialists on Codex and the integrator on GLM without a planner', () => {
    const approved = resolveAdaptiveApproval({ ...automatic, team, adaptive_team: {
      version: 1, requested_agents: [...rows, { connection: null, role: 'builder' }], model_mix } }, saved);
    expect(approved.adaptive_team).toBeUndefined();
    expect(approved.team).toEqual(team);
    expect(approved.agents.map((a: { connection: string }) => a.connection)).toEqual(['codex', 'codex', 'glm']);
    expect(approved.model_budgets.map((b: { model: string }) => b.model).sort()).toEqual(['glm-5.3-flash', 'gpt-5.6-luna']);
    expect(approved.autonomy_policy.enabled).toBe(true);
  });
  it('fails clearly instead of substituting when a required model is not connected', () => {
    for (const missing of ['codex', 'glm']) {
      const connections = saved.filter((c) => c.id !== missing);
      let failure: { code?: string; message?: string } = {};
      try {
        resolveAdaptiveApproval(automatic, connections);
      } catch (error) {
        failure = error as typeof failure;
      }
      expect(failure.code).toBe('PROVIDER_MISSING');
      expect(failure.message).toMatch(missing === 'codex' ? /GPT-5\.6 Luna/ : /GLM/);
    }
  });
  it('rejects a malformed mix and never forwards the browser hint', () => {
    for (const bad of [{ specialists: model_mix.specialists }, { ...model_mix, coordination: { provider: 'zai' } }, 'codex'])
      expect(() => resolveAdaptiveApproval({ ...automatic, adaptive_team: { ...automatic.adaptive_team, model_mix: bad } }, saved)).toThrow();
    expect(resolveAdaptiveApproval(automatic, saved).adaptive_team.model_mix).toBeUndefined();
    const forged = { ...automatic, adaptive_team: { version: 1, requested_agents: rows, specialist_connection: 'sonnet' } };
    expect(resolveAdaptiveApproval(forged, saved).adaptive_team.specialist_connection).toBeUndefined();
  });
});
