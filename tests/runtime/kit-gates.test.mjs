// Which items a kit run picks, and what a full run does with an item behind an off switch: a skip
// in realworld evidence refuses a prod deploy, so it must stay out of `items`, and say why.
import assert from 'node:assert/strict';
import test from 'node:test';
import { chosenItems, FEATURE_ITEMS, featureRun, offSwitches } from '../../tools/staging/kit-gates.mjs';

const chosen = (values) => [...chosenItems(values)];
const item = (id, status, reason) => ({ id, title: `Item ${id}`, status, ms: 1, metrics: {}, ...(reason && { reason }) });

test('a full run names nothing, and --only names what it lists', () => {
  assert.equal(chosenItems({}), null);
  assert.deepEqual(chosen({ only: '0,12,33,17' }), ['0', '12', '33', '17']);
});

test('each gate runs its items, and the first flag wins over --only', () => {
  assert.deepEqual(chosen({ 'feature-tests': true }), ['0', '12', ...FEATURE_ITEMS, '17']);
  assert.deepEqual(chosen({ 'git-semantics': true }), ['0', '12', '13', '18', '21', '23', '27', '17']);
  assert.deepEqual(chosen({ 'git-semantics': true, ssh: true }), ['0', '12', '13', '18', '21', '23', '27', '17', '26']);
  assert.deepEqual(chosen({ agents: '4', only: '0' }), ['0', '12', '29', '17']);
  assert.deepEqual(chosen({ browser: true }), ['0', 'browser']);
  assert.deepEqual(chosen({ 'reads-sessions': true, browser: true }), ['0', 'reads']);
});

test('feature items alone are no full kit; with anything else they are', () => {
  assert.equal(featureRun(new Set(['0', '12', '33', '17'])), true);
  assert.equal(featureRun(new Set(['0', '39'])), true);
  assert.equal(featureRun(new Set(['0', '12', '17'])), false);
  assert.equal(featureRun(new Set(['0', '6', '33'])), false);
  assert.equal(featureRun(null), false);
});

test('a full run lists an off switch under not_run, so its evidence can pass', () => {
  const items = [item('33', 'pass'), item('34', 'skip', 'LAND_WHEN_CLEARED is off'), item('41', 'skip', 'AUDIT_LOG is off')];
  const { ran, notRun } = offSwitches(items, null);
  assert.deepEqual(ran.map((i) => i.id), ['33']);
  assert.deepEqual(notRun, [
    { id: '34', title: 'Item 34', reason: 'LAND_WHEN_CLEARED is off' },
    { id: '41', title: 'Item 41', reason: 'AUDIT_LOG is off' },
  ]);
  assert.ok(ran.every((i) => i.status === 'pass'), 'the prod guard refuses anything else');
});

test('with its switch on an item counts like any other, even when it fails', () => {
  const items = [item('34', 'fail', 'it did not land'), item('41', 'pass')];
  assert.deepEqual(offSwitches(items, null), { ran: items, notRun: [] });
});

test('only those two can leave: any other skip still refuses a ship', () => {
  const items = [item('39', 'skip', 'No dev-owner.env'), item('8', 'skip', 'No BENCH_KEY')];
  assert.deepEqual(offSwitches(items, null), { ran: items, notRun: [] });
});

test('a run that named it records its skip', () => {
  const items = [item('34', 'skip', 'off')];
  assert.deepEqual(offSwitches(items, new Set(['0', '12', '34', '17'])), { ran: items, notRun: [] });
});
