import { expect, it, vi } from 'vitest';
import { ApiError, type api } from '../../lib/api';
import { createComparisonMutation } from './comparisonMutation';

const body = {
  run_id: 'run',
  candidate_id: 'left',
  reason: 'Preserves access',
  expected_selection_version: 0,
};
it('reconciles a late owner selection by its original ID without posting it again', async () => {
  const perform = vi.fn().mockRejectedValueOnce(new ApiError('REQUEST_TIMEOUT', 'timeout'));
  const read = vi.fn().mockResolvedValueOnce({ run: { id: 'run' } });
  const action = createComparisonMutation('repo', perform, read as typeof api);
  await expect(action.submit(body)).rejects.toThrow('timeout');
  await expect(action.submit({ ...body, reason: 'Changed' })).rejects.toThrow('unconfirmed');
  expect(action.uncertain).toBe(true);
  expect(perform).toHaveBeenCalledOnce();
  read.mockResolvedValueOnce({
    run: {
      id: 'run',
      comparison: { selection_request_id: action.requestId, selected_candidate_id: 'left' },
    },
  });
  await expect(action.submit({ ...body, reason: 'Changed again' })).resolves.toBe(true);
  expect(action.uncertain).toBe(false);
  expect(perform.mock.calls[0]).toEqual([
    'select_comparison_candidate',
    { ...body, request_id: action.requestId },
  ]);
  expect(perform).toHaveBeenCalledOnce();
});
it('keeps an uncertain owner selection locked after readback failures and matches its exact stored request', async () => {
  const perform = vi.fn().mockRejectedValueOnce(new ApiError('REQUEST_TIMEOUT', 'timeout'));
  const read = vi.fn().mockRejectedValueOnce(new ApiError('HEAD_MOVED', 'changed'));
  const action = createComparisonMutation('repo', perform, read as typeof api);
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
