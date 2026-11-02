// A driver completing is not proof that a real agent completed the requested Flight.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

export function removeOwnedContainer(name, run = spawnSync) {
  assert.match(name, /^yoneda-demo-[a-z0-9-]+$/);
  if (run('docker', ['rm', '-f', name], { stdio: 'ignore' }).status === 0) return;
  const listed = run('docker', ['container', 'ls', '-a', '--filter', `name=^/${name}$`, '--format', '{{.ID}}'], { encoding: 'utf8' });
  assert.ok(listed.status === 0 && listed.stdout.trim() === '', 'Could not remove an owned agent container or confirm it was already removed');
}

export class DemoTokens {
  paths = new Set();
  constructor(owner) { this.owner = owner; }
  track(path) { this.paths.add(path); }
  async revoke(path) {
    assert.ok((await this.owner.raw('DELETE', path)).ok, 'Could not revoke a temporary demo token');
    this.paths.delete(path);
  }
  cleanup() { return [...this.paths].map(path => () => this.revoke(path)); }
}

export function assertFlight(result, { want, proof = false }) {
  assert.ok(Number.isSafeInteger(result?.number) && result.number > 0 && /^[0-9a-f]{40}$/.test(result.head), 'No exact Landing head was read back');
  assert.ok(typeof result.plan === 'string' && result.plan.trim(), 'The Landing has no Flight Plan');
  assert.equal(result.outcome, want, `Landing ${result.number}: wanted ${want}, got ${result.outcome}`);
  for (const name of ['slop', 'drift']) assert.ok(['passed', 'findings'].includes(result[name]?.status), `${name} review did not complete successfully`);
  if (want === 'landed') {
    assert.equal(result.status, 'landed', 'The Landing is not landed');
    assert.match(result.landed_commit ?? '', /^[0-9a-f]{40}$/, 'No landed commit was read back');
  } else assert.equal(result.status, 'open', 'A held or go-around Landing must stay open');
  if (proof) assert.equal(result.proof?.outcome, 'avoided', 'The pushed revision did not satisfy the memory proof');
}

/** Attempt every cleanup, then fail on any cleanup error, unreadable host state or drift. */
export async function finishDemoRun({ clean, check }) {
  const failures = [];
  for (const step of clean) {
    try { await step(); } catch (error) { failures.push(error); }
  }
  try {
    const drift = await check();
    if (drift.length) failures.push(new Error(drift.join('; ')));
  } catch (error) { failures.push(error); }
  if (failures.length) throw new AggregateError(failures, failures.map(error => error.message).join('; '));
}
