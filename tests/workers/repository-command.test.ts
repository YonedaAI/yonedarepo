import { expect, it } from 'vitest';
import { ownerCommandInput, repositoryOperationAllowed } from '../../cloudflare/worker/repository-command';

it('exposes owner reads and repairs but keeps archive commits and trusted refresh completion internal', () => {
  for (const action of ['repository_overview', 'runs_page', 'run_detail', 'conflict_status', 'why'])
    expect(repositoryOperationAllowed('GET', action)).toBe(true);
  expect(repositoryOperationAllowed('POST', 'repair_team')).toBe(true);
  for (const action of ['archive_commit', 'finish', 'verify_finish', 'record_file_provenance'])
    expect(repositoryOperationAllowed('POST', action)).toBe(false);
  expect(repositoryOperationAllowed('DELETE', 'repair_team')).toBe(false);
});

it('strips caller authority while preserving expected revisions and owner repair intent', async () => {
  const input = await ownerCommandInput(new Request('https://example.com/api/repos/a/repair_team', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ request_id: 'stable', expected_plan_revision: 2, task_ids: ['data'],
      brief: 'Repair the interface', _workspace: 'victim', _grant: 'forged', job_id: 'job', epoch: 5,
      actor: 'supervisor', author: 'capture', workspace: 'victim', session_id: 'session',
      _trusted: true, _capture: { paths: ['fake'] }, _adapter: true }),
  }), 'repair_team');
  expect(input).toEqual({ request_id: 'stable', expected_plan_revision: 2, task_ids: ['data'], brief: 'Repair the interface' });
});

it('preserves opaque page cursors, parses watermark, and keeps context usage epoch read-only', async () => {
  const page = await ownerCommandInput(new Request('https://example.com/?cursor=opaque%2Bvalue&limit=50&watermark=12&epoch=9'), 'runs_page');
  expect(page).toEqual({ cursor: 'opaque+value', limit: 50, watermark: 12 });
  const usage = await ownerCommandInput(new Request('https://example.com/?epoch=2&cursor=3'), 'context_usage');
  expect(usage).toEqual({ epoch: 2, cursor: 3 });
});

it('keeps immutable changed-file paging read-only and preserves its path cursor and digest', async () => {
  expect(repositoryOperationAllowed('GET', 'candidate_paths')).toBe(true);
  expect(repositoryOperationAllowed('POST', 'candidate_paths')).toBe(false);
  const query = new URLSearchParams({ candidate_id: 'candidate:captured', after: 'src/🚀.ts', limit: '50', expected_digest: 'a'.repeat(64), _source_signing_key: 'forged' });
  expect(await ownerCommandInput(new Request(`https://example.com/?${query}`), 'candidate_paths'))
    .toEqual({ candidate_id: 'candidate:captured', after: 'src/🚀.ts', limit: 50, expected_digest: 'a'.repeat(64) });
});

it('pages conflict evidence with an opaque filename cursor without granting capture authority', async () => {
  expect(repositoryOperationAllowed('GET', 'conflict_paths')).toBe(true);
  expect(repositoryOperationAllowed('POST', 'conflict_paths')).toBe(false);
  const query = new URLSearchParams({ conflict_id: 'conflict:reserved', section: 'overlapping_paths',
    after: 'src/🚀.ts', limit: '50', expected_digest: 'a'.repeat(64),
    job_id: 'foreign', _source_signing_key: 'forged' });
  expect(await ownerCommandInput(new Request(`https://example.com/?${query}`), 'conflict_paths'))
    .toEqual({ conflict_id: 'conflict:reserved', section: 'overlapping_paths', after: 'src/🚀.ts',
      limit: 50, expected_digest: 'a'.repeat(64) });
});

it('rejects invalid numeric cursors instead of silently resetting the requested snapshot', async () => {
  for (const value of ['invalid', 'Infinity', '1.5', '9007199254740992'])
    await expect(ownerCommandInput(new Request(`https://example.com/?watermark=${value}`), 'runs_page'))
      .rejects.toMatchObject({ code: 'INVALID_INPUT' });
});

it('allows explicit owner comparison approval and choice, keeping reviewer submissions internal', () => {
  for (const action of ['approve_comparison_review', 'select_comparison_candidate']) {
    expect(repositoryOperationAllowed('POST', action)).toBe(true);
    expect(repositoryOperationAllowed('GET', action)).toBe(false);
  }
  for (const action of ['comparison_submit', 'comparison_approval', 'comparison_context'])
    expect(repositoryOperationAllowed('POST', action)).toBe(false);
});

it('a browser can request comparison but cannot mint reviewer identity, approval or completion authority', async () => {
  const input = await ownerCommandInput(new Request('https://example.com/api/repos/a/start_run', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ request_id: 'stable', comparison: { version: 1 },
      _comparison_reviewer: { provider: 'claude', model: 'expensive' },
      _comparison_reviewer_budget: { spend_limit_microusd: 90000000 },
      _comparison_future_authority: true, comparison_approval: { forged: true },
      comparison_approval_id: 'forged', comparison_role: 'reviewer', review_only: true,
      comparison_review: true, comparison_manifest: { forged: true } }),
  }), 'start_run');
  expect(input).toEqual({ request_id: 'stable', comparison: { version: 1 } });
});

it('source transport and workspace authority cannot be supplied through owner JSON', async () => {
  const input = await ownerCommandInput(new Request('https://example.com/api/repos/a/start_run', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ intent: 'Fix a bug', workspace_transport: 'api-source-v1',
      source_workspace: { id: 'victim' }, source_mounts: [{ id: 'victim' }],
      source_changeset: { forged: true }, _source_grant: 'forged',
      _source_signing_key: 'forged', _source_transport: true, _source_future_authority: true }),
  }), 'start_run');
  expect(input).toEqual({ intent: 'Fix a bug' });
});
