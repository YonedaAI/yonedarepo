import { expect, it } from 'vitest';
import { RepositoryReads } from './repositoryReads';

it('cancels all obsolete repository and discovery reads while preserving a later scope', () => {
  const reads = new RepositoryReads();
  const oldRepository = reads.begin();
  const discovery = reads.begin();
  const finished = reads.begin();
  reads.end(finished);
  reads.cancel();
  expect(oldRepository.signal.aborted).toBe(true);
  expect(discovery.signal.aborted).toBe(true);
  expect(finished.signal.aborted).toBe(false);
  const next = reads.begin();
  expect(next.signal.aborted).toBe(false);
  reads.cancel();
  expect(next.signal.aborted).toBe(true);
});
