import { expect, it, vi } from 'vitest';
import { ApiError, type api } from '../../lib/api';
import { createComparisonMutation } from './comparisonMutation';

it('reconciles a late review approval by its original ID without posting another paid request', async () => {
  const perform = vi.fn().mockRejectedValueOnce(new ApiError('REQUEST_TIMEOUT', 'timeout'));
  const read = vi.fn().mockResolvedValueOnce({ run: { id: 'run' } });
  const action = createComparisonMutation(
    'repo',
    'approve_comparison_review',
    perform,
    read as typeof api,
  );
  const body = { run_id: 'run', expected_commit: 'original', expected_version: 2 };
  await expect(action.submit(body)).rejects.toThrow('timeout');
  await expect(action.submit({ ...body, expected_version: 3 })).rejects.toThrow('unconfirmed');
  expect(action.uncertain).toBe(true);
  expect(perform).toHaveBeenCalledOnce();
  read.mockResolvedValueOnce({
    run: {
      id: 'run',
      comparison: {
        approval: {
          request_id: action.requestId,
          id: `comparison-approval:run:${action.requestId}`,
        },
      },
    },
  });
  await expect(action.submit({ ...body, expected_commit: 'moved' })).resolves.toBe(true);
  expect(action.uncertain).toBe(false);
  expect(perform.mock.calls[0][1]).toMatchObject(body);
  expect(perform).toHaveBeenCalledOnce();
});
it('keeps an uncertain owner selection locked after readback failures and matches its exact stored request', async () => {
  const perform = vi.fn().mockRejectedValueOnce(new ApiError('REQUEST_TIMEOUT', 'timeout'));
  const read = vi.fn().mockRejectedValueOnce(new ApiError('HEAD_MOVED', 'changed'));
  const action = createComparisonMutation(
    'repo',
    'select_comparison_candidate',
    perform,
    read as typeof api,
  );
  const body = {
    run_id: 'run',
    candidate_id: 'left',
    reason: 'Preserves access',
    expected_selection_version: 0,
  };
  await expect(action.submit(body)).rejects.toThrow('timeout');
  await expect(action.submit({ ...body, candidate_id: 'right' })).rejects.toThrow('changed');
  expect(action.uncertain).toBe(true);
  read.mockResolvedValueOnce({
    run: {
      id: 'run',
      comparison: { selection_request_id: action.requestId, selected_candidate_id: 'left' },
    },
  });
  await expect(action.submit(body)).resolves.toBe(true);
  expect(perform).toHaveBeenCalledOnce();
});
