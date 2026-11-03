import assert from 'node:assert/strict';
import { test } from 'node:test';
import { approveHeldFlight } from '../../tools/staging/demo-repos-approval.mjs';

const held = { number: 1, head: 'a'.repeat(40), outcome: 'hold', status: 'open' };
function fixture(gates = { approvals: 0, approvals_required: 1 }) {
  const calls = [];
  const owner = { get: async () => ({ head: held.head, head_commit: { gates } }) };
  const reviewer = { raw: async (...args) => { calls.push(args); return { ok: true, body: { decision: 'approve' } }; } };
  const wait = async () => ({ outcome: 'landed', status: 'landed', landed_commit: 'b'.repeat(40) });
  return { owner, reviewer, held, repo: 'demo', origin: 'https://dev.yonedarepo.com', wait, calls };
}
test('a real second account approves the captured held head before policy restoration', async () => {
  const f = fixture();
  const proof = await approveHeldFlight(f);
  assert.equal(f.calls[0][1], `/api/v1/repos/demo/commits/${held.head}/reviews`);
  assert.equal(proof.before.approvals, 0);
  assert.equal(proof.after.outcome, 'landed');
});
test('a changed head or a hold for another reason is never approved', async () => {
  const f = fixture({ approvals: 1, approvals_required: 1 });
  await assert.rejects(approveHeldFlight(f), /approval hold/);
  const stale = fixture();
  stale.owner.get = async () => ({ head: 'c'.repeat(40) });
  await assert.rejects(approveHeldFlight(stale), /head changed/);
  assert.equal(f.calls.length + stale.calls.length, 0);
});
test('a denied review or a failure to land cannot be reported as approval success', async () => {
  const f = fixture();
  f.reviewer.raw = async () => ({ ok: false, status: 403 });
  await assert.rejects(approveHeldFlight(f), /refused/);
  const blocked = fixture();
  blocked.wait = async () => ({ outcome: 'hold', status: 'open' });
  await assert.rejects(approveHeldFlight(blocked), /did not land/);
});
