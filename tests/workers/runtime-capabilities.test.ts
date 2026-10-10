import { expect, it } from 'vitest';
import { checkRuntime } from '../../cloudflare/worker/runtime';

const checkFailureCode = (health: any, job: any) => {
  let failure: unknown;
  try {
    checkRuntime(health, job);
  } catch (error) {
    failure = error;
  }
  expect(failure).toMatchObject({ code: 'RUNTIME_UPDATING' });
};

it('defers frozen Git-native jobs until the runtime image advertises Git transport', () => {
  const job = { kind: 'agent', payload: { workspace_transport: 'git-native-v1' } };
  checkFailureCode({ protocol: 2, capabilities: {} }, job);
  expect(() => checkRuntime({ protocol: 2, capabilities: { git_native_transport: 1 } }, job)).not.toThrow();
  expect(() => checkRuntime({ protocol: 2, capabilities: {} }, { kind: 'agent', payload: {} })).not.toThrow();
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
