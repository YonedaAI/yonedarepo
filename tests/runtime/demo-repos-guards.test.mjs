import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DemoGuards } from '../../tools/staging/demo-repos-guards.mjs';

function fixture({ used = 2.853516, overrides = {}, pending = [], refs = { 'refs/heads/main': 'a'.repeat(40) } } = {}) {
  const calls = [];
  const agents = ['slop-review', 'intent-drift'].map(id => ({ id, active: true, enabled_repos: ['demo'], cost_cap_usd: 0.5, fallback: [], settings: { block_at: 'high', trigger: { when: 'push', changes: 'ready_for_review', paths: [], branches: [] } }, repo_overrides: overrides }));
  const account = { get: async path => path.includes('/runs?') ? { runs: pending } : { capabilities: ['exact_head_review'], credit: { used_usd: used }, agents }, call: async (...args) => calls.push(args) };
  const owner = { get: async path => path.endsWith('/refs') ? { refs: structuredClone(refs) } : { policy: { approvals: 0, required_checks: ['tests'] } }, call: async (...args) => calls.push(args) };
  const guard = new DemoGuards({ account, owner, managed: '/managed', baseline: 1.15439, capUsd: 2.9 });
  return { guard, calls };
}

test('a head reserves every enabled reviewer maximum before the coder starts', async () => {
  assert.equal((await fixture().guard.reserve('demo')).worst_usd, 1);
  await assert.rejects(fixture({ used: 3.055 }).guard.reserve('demo'), /managed cap/);
});

test('unsettled earlier reviews cannot escape the pre-head budget', async () => {
  await assert.rejects(fixture({ pending: [{ status: 'running' }] }).guard.reserve('demo'), /unsettled/);
});

test('temporary Slop changes are repository scoped and restored after failure', async () => {
  const { guard, calls } = fixture();
  await assert.rejects(guard.run(async () => { await guard.slop('demo', 'medium'); throw new Error('coder failed'); }), /coder failed/);
  assert.deepEqual(calls, [
    ['PUT', '/managed/agents/slop-review', { scope: 'demo', settings: { block_at: 'medium' } }],
    ['PUT', '/managed/agents/slop-review', { scope: 'demo', settings: { block_at: 'high' } }],
  ]);
});

test('an unreadable existing override is not overwritten or guessed', async () => {
  const { guard, calls } = fixture({ overrides: { demo: ['block_at'] } });
  await assert.rejects(guard.slop('demo', 'medium'), /existing.*override/);
  assert.deepEqual(calls, []);
});

test('approval policy is restored even when the browser save fails', async () => {
  const { guard, calls } = fixture();
  await assert.rejects(guard.run(async () => guard.approvals('demo', async () => { throw new Error('browser failed'); })), /browser failed/);
  assert.deepEqual(calls, [['PUT', '/repos/demo/policy', { policy: { approvals: 0, required_checks: ['tests'] } }]]);
});

test('a restore failure still attempts every saved setting and fails the run', async () => {
  const { guard, calls } = fixture();
  await guard.slop('demo', 'medium');
  await guard.approvals('demo', async () => {});
  guard.account.call = async () => { throw new Error('restore refused'); };
  await assert.rejects(guard.run(async () => {}), /restore refused/);
  assert.equal(calls.at(-1)[1], '/repos/demo/policy');
});

test('coding suppresses only that repository until exact-head reviews settle', async () => {
  const { guard, calls } = fixture();
  await guard.run(async () => {
    await guard.suppress('demo');
    assert.equal(calls.length, 2);
    assert.ok(calls.every(call => call[2].scope === 'demo' && call[2].settings.trigger.branches[0] === '?'));
    const reserved = await guard.review('demo', { number: 7, head: 'b'.repeat(40), branch: 'feature' });
    assert.equal(reserved.worst_usd, 1);
    assert.equal(calls.filter(call => call[0] === 'POST').length, 2);
  });
  assert.deepEqual(calls.slice(-2).map(call => call[2].settings.trigger.branches), [[], []]);
});

test('unexpected additional publications leave triggers suppressed instead of charging later', async () => {
  const { guard, calls } = fixture();
  await guard.suppress('demo');
  guard.owner.get = async () => ({ refs: { 'refs/heads/main': 'a'.repeat(40), 'refs/heads/unexpected': 'c'.repeat(40) } });
  await assert.rejects(guard.run(async () => {}), /unreviewed.*publication/);
  assert.equal(calls.length, 2, 'no automatic trigger was restored');
});

for (const deleted of ['refs/heads/retained', 'refs/tags/retained'])
  test(`deleting initial ${deleted} keeps automatic reviews suppressed`, async () => {
    const refs = { 'refs/heads/main': 'a'.repeat(40), 'refs/heads/retained': 'b'.repeat(40), 'refs/tags/retained': 'c'.repeat(40) };
    const { guard, calls } = fixture({ refs });
    await guard.suppress('demo');
    const now = { ...refs };
    delete now[deleted];
    guard.owner.get = async () => ({ refs: now });
    await assert.rejects(guard.run(async () => {}), /deleted initial ref/);
    assert.equal(calls.length, 2, 'neither automatic trigger was restored');
  });

test('a landed result alone cannot authorize deleting its initial branch', async () => {
  const refs = { 'refs/heads/main': 'a'.repeat(40), 'refs/heads/feature': 'b'.repeat(40), 'refs/tags/retained': 'c'.repeat(40) };
  const { guard, calls } = fixture({ refs });
  await guard.suppress('demo');
  guard.owner.get = async () => ({ refs: { 'refs/heads/main': 'd'.repeat(40), 'refs/tags/retained': refs['refs/tags/retained'] } });
  await guard.complete('demo', { branch: 'feature', head: 'd'.repeat(40), status: 'landed' });
  await assert.rejects(guard.run(async () => {}), /deleted initial ref/);
  assert.equal(calls.length, 2);
});

test('a completed target may move while every initial branch and tag remains present', async () => {
  const refs = { 'refs/heads/main': 'a'.repeat(40), 'refs/heads/feature': 'b'.repeat(40), 'refs/tags/retained': 'c'.repeat(40) };
  const { guard, calls } = fixture({ refs });
  await guard.suppress('demo');
  const head = 'd'.repeat(40);
  guard.owner.get = async () => ({ refs: { ...refs, 'refs/heads/main': head, 'refs/heads/feature': head } });
  await guard.complete('demo', { branch: 'feature', head, status: 'landed' });
  await guard.run(async () => {});
  assert.equal(calls.length, 4);
});

test('an existing trigger override is refused before any suppression write', async () => {
  const { guard, calls } = fixture({ overrides: { demo: ['trigger'] } });
  await assert.rejects(guard.suppress('demo'), /existing.*override/);
  assert.equal(calls.length, 0);
});

test('only a completed exact publication permits trigger restoration', async () => {
  const { guard, calls } = fixture();
  await guard.suppress('demo');
  const head = 'b'.repeat(40);
  guard.owner.get = async () => ({ refs: { 'refs/heads/main': 'a'.repeat(40), 'refs/heads/feature': head } });
  await assert.rejects(guard.safeToRestore('demo'), /unreviewed/);
  await guard.complete('demo', { branch: 'feature', head, status: 'open' });
  await guard.run(async () => {});
  assert.equal(calls.length, 4);
});

test('paused reviews and an increased total cap fail closed', async () => {
  await assert.rejects(fixture({ pending: [{ status: 'paused' }] }).guard.reserve('demo'), /unsettled/);
  assert.throws(() => new DemoGuards({ capUsd: 3 }), /original demo cap/);
});

test('an old deployment that would ignore exact-head selectors cannot start coding', async () => {
  const { guard, calls } = fixture();
  guard.account.get = async () => ({ agents: [] });
  await assert.rejects(guard.suppress('demo'), /exact-head.*not deployed/);
  assert.equal(calls.length, 0);
});
