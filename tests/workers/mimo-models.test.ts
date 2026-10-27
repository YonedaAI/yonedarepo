import { expect, it } from 'vitest';
import { providerDefinition } from '../../shared/providers';
import { resolveRunRoster } from '../../cloudflare/worker/run-roster';
import { normalizeReasoningEffort } from '../../cloudflare/worker/model-reasoning';
const connections = [
 {id:'managed-flash',provider:'mimo',model:'mimo-v2.6-flash',version:2,routing:null},
 {id:'personal-flash',provider:'mimo',model:'mimo-v2.6-flash',version:3,routing:null},
 {id:'saved-pro',provider:'mimo',model:'mimo-v2.6-pro',version:1,routing:{plan:'token_plan',region:'sgp'}},
];
  it('freezes an explicit saved connection without a fallback', () => {
    for (const connection of [connections[0], connections[2]]) {
      const input = {
        adaptive_team: {
          version: 1,
          requested_agents: [{ connection: connection.id, role: 'builder' }],
        },
      };
      const approved = resolveRunRoster(input, connections);
      expect(approved.agents[0]).toMatchObject({
        connection: connection.id,
        provider: 'mimo',
        model: connection.model,
      });
    }
    expect(() =>
      resolveRunRoster(
        { adaptive_team: { version: 1, requested_agents: [{ connection: null, role: 'auto' }] } },
        connections,
      ),
    ).toThrow();
    expect(() =>
      resolveRunRoster(
        {
          adaptive_team: {
            version: 1,
            requested_agents: [{ connection: 'missing', role: 'builder' }],
          },
        },
        connections,
      ),
    ).toThrow();
  });


it('rejects invented MiMo reasoning controls without silently changing the frozen model', () => {
 for(const model of providerDefinition('mimo').models) {
  expect(normalizeReasoningEffort('mimo',model.id,undefined)).toBeUndefined();
  for(const effort of ['low','high','max','on','off']) expect(()=>normalizeReasoningEffort('mimo',model.id,effort)).toThrow();
 }
});
