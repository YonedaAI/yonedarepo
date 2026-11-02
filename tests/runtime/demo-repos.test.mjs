import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { AGENTS_BY_KIND, REPOS } from '../../tools/staging/demo-repos-plan.mjs';
import { demoFlights } from '../../tools/staging/demo-repos-flights.mjs';
import { assertFlight, finishDemoRun, removeOwnedContainer, DemoTokens } from '../../tools/staging/demo-repos-acceptance.mjs';

test('retained demos use supported sandbox agents without the removed proxy', () => {
  for (const repo of Object.values(REPOS))
    for (const kind of [repo.agent, ...Object.values(repo.flights).map((f) => f.agent).filter(Boolean)]) {
      assert.ok(['glm', 'codex', 'claude'].includes(kind), `${repo.project}: unsupported ${kind}`);
      assert.ok(AGENTS_BY_KIND[kind]);
    }
});

test('a demo dry run needs no login, Docker, model credential or writes', () => {
  const run = spawnSync(process.execPath, ['tools/staging/demo-repos.mjs', '--dry-run', '--only', 'commander'], {
    cwd: new URL('../..', import.meta.url), encoding: 'utf8', env: { PATH: process.env.PATH }, timeout: 5000,
  });
  assert.equal(run.status, 0, run.stderr);
  const plan = JSON.parse(run.stdout);
  assert.deepEqual(plan.repositories, ['commander']);
  assert.ok(plan.phases.includes('drift'));
  assert.equal(plan.models.codex, 'gpt-5.6-luna');
});

test('a failed repository phase makes the demo command fail', async () => {
  const { eachRepo } = demoFlights({ state: {}, save: () => {}, scrub: String, log: () => {} });
  await assert.rejects(eachRepo([{ key: 'fixture' }], 'clean', async () => { throw new Error('no push'); }), /failed/);
});

test('a Flight needs the requested outcome, successful reviews and its actual proof', () => {
  const good = { number: 1, head: 'a'.repeat(40), plan: 'Build a feature', outcome: 'landed', status: 'landed', landed_commit: 'b'.repeat(40), slop: { status: 'passed' }, drift: { status: 'findings' }, proof: { outcome: 'avoided' } };
  assert.doesNotThrow(() => assertFlight(good, { want: 'landed', proof: true }));
  for (const bad of [{ outcome: 'hold' }, { slop: { status: 'failed' } }, { proof: { outcome: 'fell' } }, { landed_commit: null }, { plan: null }])
    assert.throws(() => assertFlight({ ...good, ...bad }, { want: 'landed', proof: true }));
});

test('host drift fails even when token cleanup succeeds', async () => {
  const events = [];
  await assert.rejects(finishDemoRun({ clean: [async () => { events.push('cleanup'); }], check: async () => ['host changed'] }), /host changed/);
  assert.deepEqual(events, ['cleanup']);
});

test('a cleanup failure does not skip other cleanup or the host check', async () => {
  const events = [];
  await assert.rejects(finishDemoRun({ clean: [async () => { events.push('first'); throw new Error('cleanup failed'); }, async () => { events.push('second'); }], check: async () => { events.push('host'); return []; } }), /cleanup failed/);
  assert.deepEqual(events, ['first', 'second', 'host']);
});

test('container cleanup accepts automatic removal only after confirming absence', () => {
  let calls = 0;
  removeOwnedContainer('yoneda-demo-fixture', () => ++calls === 1 ? { status: 1 } : { status: 0, stdout: '' });
  assert.equal(calls, 2);
  for (const listed of [{ status: 1, stdout: '' }, { status: 0, stdout: 'still-present' }])
    assert.throws(() => removeOwnedContainer('yoneda-demo-fixture', (_command, args) => args[0] === 'rm' ? { status: 1 } : listed));
});

test('a failed release-token revocation remains tracked for retry', async () => {
  let calls = 0;
  const tokens = new DemoTokens({ raw: async () => ({ ok: ++calls > 1 }) });
  const path = '/repos/r00000000000000000001/tokens/demo-tags-fixture';
  tokens.track(path);
  await assert.rejects(tokens.revoke(path), /revoke/);
  assert.equal(tokens.paths.size, 1);
  await finishDemoRun({ clean: tokens.cleanup(), check: async () => [] });
  assert.equal(tokens.paths.size, 0);
});
