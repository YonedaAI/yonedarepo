import assert from 'node:assert/strict';

/** Preserve the held observation, then prove approval by another account actually lands it. */
export async function approveHeldFlight({ owner, reviewer, held, repo, origin, wait }) {
  const change = await owner.get(`/repos/${repo}/changes/${held.number}`);
  assert.equal(change.head, held.head, 'the held head changed before approval');
  const before = change.head_commit?.gates;
  assert.ok(held.outcome === 'hold' && held.status === 'open' && before?.approvals < before?.approvals_required, 'the change is not an approval hold');
  const approved = await reviewer.raw('POST', `/api/v1/repos/${repo}/commits/${held.head}/reviews`, { decision: 'approve' }, { origin });
  assert.ok(approved.ok && approved.body?.decision === 'approve', `second-person approval refused: ${approved.status ?? 'invalid response'}`);
  const after = await wait();
  assert.ok(after.outcome === 'landed' && after.status === 'landed' && /^[0-9a-f]{40}$/.test(after.landed_commit ?? ''), 'the independently approved change did not land');
  return { before, decision: 'approve', after };
}
