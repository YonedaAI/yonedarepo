import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cookieHeader, scrub, settle } from '../../tools/staging/browser-flow.mjs';
import { compareState } from '../../tools/staging/project-flow.mjs';

const run = (fields = {}) => ({ id: 'run-1', mode: 'compare', status: 'running', ...fields });
const execution = (status) => ({ id: `e-${status}`, run_id: 'run-1', status });
const candidate = (status, id = `c-${status}`) => ({ id, run_id: 'run-1', status });

test('compare runs wait while any attempt is active, even with a checked result', () => {
  const state = compareState({ run: run(), executions: [execution('running'), execution('completed')], candidates: [candidate('eligible')] });
  assert.equal(state.status, 'waiting');
  assert.equal(state.eligible.length, 1);
  assert.equal(compareState({ run: run({ status: 'planning' }) }).status, 'waiting');
});

test('the owner chooses once work stopped with a checked result, a failed attempt aside', () => {
  const state = compareState({ run: run({ status: 'ready' }), executions: [execution('failed'), execution('completed')], candidates: [candidate('eligible'), candidate('rejected')] });
  assert.equal(state.status, 'choose');
  assert.deepEqual(state.eligible.map((c) => c.id), ['c-eligible']);
});

test("another run's candidates never count", () => {
  const state = compareState({ run: run({ status: 'ready' }), executions: [execution('completed')], candidates: [{ id: 'x', run_id: 'run-2', status: 'eligible' }, candidate('evaluating')] });
  assert.equal(state.status, 'waiting');
});

test('an owner selection wins over every other state', () => {
  assert.equal(compareState({ run: run({ status: 'failed', comparison: { selected_candidate_id: 'c' } }) }).status, 'selected');
});

test('stopped work without a checked result fails with the reason', () => {
  const rejected = compareState({ run: run({ status: 'ready' }), executions: [execution('completed')], candidates: [candidate('rejected')] });
  assert.equal(rejected.status, 'failed');
  assert.match(rejected.reason, /no checked result \(rejected\)/);
  const none = compareState({ run: run({ status: 'failed' }), executions: [execution('failed')] });
  assert.equal(none.reason, 'no agent captured a result');
  assert.equal(compareState({ run: run({ status: 'cancelled' }) }).status, 'failed');
  // Nothing scheduled yet is not a failure.
  assert.equal(compareState({ run: run({ status: 'ready' }) }).status, 'waiting');
});

test('cookie header joins every cookie', () => {
  assert.equal(cookieHeader([{ name: 'a', value: '1' }, { name: 'b', value: '2' }]), 'a=1; b=2');
});

test('scrub removes secrets from evidence and ignores empty ones', () => {
  assert.equal(scrub('pw=hunter22 again hunter22', ['hunter22', '', undefined]), 'pw=[redacted] again [redacted]');
});

const shown = (visible, text = '') => ({ first: () => shown(visible, text), isVisible: async () => visible, innerText: async () => text });

test('settle returns when the expected element shows', async () => {
  await settle(shown(true), [shown(true, 'ignored')], { timeoutMs: 1000, what: 'ok' });
});

test('settle stops at the first visible failure with its text', async () => {
  await assert.rejects(settle(shown(false), [shown(false), shown(true, 'STALE_HEAD: main moved')], { timeoutMs: 5000, what: 'publication' }), /publication: STALE_HEAD: main moved/);
});

test('settle times out when nothing shows', async () => {
  await assert.rejects(settle(shown(false), [], { timeoutMs: 0, what: 'sign-in' }), /Timed out waiting for sign-in/);
});
