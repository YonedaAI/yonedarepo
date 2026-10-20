import { expect, it } from 'vitest';
import { checkLedger, checkRuntime } from '../../cloudflare/worker/runtime';

it('refuses a static-only planner image for an approved managed app before paid work', () => {
  const job = { kind: 'agent', payload: { team_planning: true, policy: { build: { app: { version: 1 } } } } };
  const health = { protocol: 2, suites: ['commands-v1'], capabilities: { app_bundle: 1, team_planning: 1 } };
  expect(() => checkRuntime(health, job)).toThrow('app planning');
  expect(() => checkRuntime({ ...health, capabilities: { ...health.capabilities, app_planning: 1 } }, job)).not.toThrow();
});

const checkFailureCode = (health: any, job: any) => {
  let failure: unknown;
  try {
    checkRuntime(health, job);
  } catch (error) {
    failure = error;
  }
  expect(failure).toMatchObject({ code: 'RUNTIME_UPDATING' });
};

it('requires lazy source, incremental capture and child privilege isolation before API-source work', () => {
  const job = { kind: 'agent', payload: { workspace_transport: 'api-source-v1' } };
  const capabilities = { source_api: 1, lazy_source: 1, source_capture: 1, child_privilege_drop: 1 };
  for (const missing of Object.keys(capabilities)) {
    const incomplete = { ...capabilities, [missing]: 0 };
    checkFailureCode({ protocol: 2, capabilities: incomplete }, job);
  }
  expect(() => checkRuntime({ protocol: 2, capabilities }, job)).not.toThrow();
});

it('defers frozen test-bundle policy until the runtime image advertises bundle evaluation', () => {
  const job = {
    kind: 'evaluate',
    payload: {
      policy: {
        environment: 'test',
        suite: 'commands-v1',
        build: { test_bundle: { digest: 'a'.repeat(64), protected_paths: ['tests'] } },
      },
    },
  };
  const health = { protocol: 2, environment: 'test', suites: ['commands-v1'], capabilities: {} };
  checkFailureCode(health, job);
  expect(() =>
    checkRuntime({ ...health, capabilities: { test_bundle: 1 } }, job),
  ).not.toThrow();
  expect(() =>
    checkRuntime(health, {
      kind: 'evaluate',
      payload: { policy: { environment: 'test', suite: 'commands-v1', build: {} } },
    }),
  ).not.toThrow();
});


it('refuses an explicit reasoning choice before a ledger can freeze it, while preserving Auto', () => {
  const snapshot = { capabilities: { artifact_reads: 2, adaptive_teams: 1, agent_limits: { min_root_agents: 1 } } };
  const request = { adaptive_team: { version: 1, requested_agents: [{ connection: 'saved', role: 'auto', reasoning_effort: 'high' }] } };
  expect(() => checkLedger(snapshot, request)).toThrow('reasoning');
  expect(() => checkLedger({ capabilities: { ...snapshot.capabilities, reasoning_effort: 1 } }, request)).not.toThrow();
  expect(() => checkLedger(snapshot, { adaptive_team: { version: 1, requested_agents: [{ connection: null, role: 'auto' }] } })).not.toThrow();
});

it('refuses a runtime that would silently ignore a frozen explicit reasoning effort', () => {
  const job = { kind: 'agent', payload: { execution: { reasoning_effort: 'high' } } };
  checkFailureCode({ protocol: 2, capabilities: {} }, job);
  expect(() => checkRuntime({ protocol: 2, capabilities: { reasoning_efforts: 1 } }, job)).not.toThrow();
  expect(() => checkRuntime({ protocol: 2, capabilities: {} }, { kind: 'agent', payload: { execution: {} } })).not.toThrow();
});

it('refuses a frozen specialist connection until the ledger can normalize it', () => {
  const snapshot = { capabilities: { artifact_reads: 2, adaptive_teams: 1, agent_limits: { min_root_agents: 1 } } };
  const request = { adaptive_team: { version: 1, requested_agents: [{ connection: null, role: 'backend' }], specialist_connection: 'codex' } };
  expect(() => checkLedger(snapshot, request)).toThrow('updating');
  expect(() => checkLedger({ capabilities: { ...snapshot.capabilities, adaptive_specialists: 1 } }, request)).not.toThrow();
});
