import { expect, it } from 'vitest';
import { checkRuntime } from '../../cloudflare/worker/runtime';

it('fences an older hosted MCP image for newly tracked runs while allowing legacy jobs', () => {
  const health = { protocol: 2 };
  const tracked = { kind: 'agent', payload: { run: { context_usage_version: 1 } } };
  expect(() => checkRuntime(health, tracked)).toThrow('context evidence');
  expect(() => checkRuntime({ ...health, capabilities: { context_usage: 1 } }, tracked)).not.toThrow();
  expect(() => checkRuntime(health, { kind: 'agent', payload: { run: {} } })).not.toThrow();
});

it('requires the isolated study prompt capability before paid study work', () => {
  const job = { kind: 'agent', payload: { run: { context_study: { arm: 'plain_notes' } } } };
  expect(() => checkRuntime({ protocol: 2 }, job)).toThrow('context study');
  expect(() => checkRuntime({ protocol: 2, capabilities: { context_study: 1 } }, job)).not.toThrow();
});
