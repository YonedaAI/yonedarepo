import { expect, it, vi } from 'vitest';
import { sourceCaptureRef } from '../../cloudflare/worker/source-capture-ref';

it('freezes the private fork branch HEAD independently from the immutable source parent', async () => {
  const log = vi.fn(async () => [{ hash: 'c'.repeat(40) }]);
  const repo = { info: async () => ({ defaultBranch: 'review/development' }), log } as unknown as ArtifactsRepo;
  expect(await sourceCaptureRef(repo)).toEqual({ branch: 'review/development', expected_head: 'c'.repeat(40) });
  expect(log).toHaveBeenCalledWith({ ref: 'review/development', limit: 1 });
});

it('rejects unsafe or missing assigned fork refs without using a guessed branch or base as the expected HEAD', async () => {
  for (const branch of ['../main', 'review//main', 'main.lock', 'main@{0}', 'main:other', '/main', 'main ', 'main.']) {
    const log = vi.fn();
    await expect(sourceCaptureRef({ info: async () => ({ defaultBranch: branch }), log } as unknown as ArtifactsRepo))
      .rejects.toMatchObject({ code: 'INVALID_CAPTURE' });
    expect(log).not.toHaveBeenCalled();
  }
  await expect(sourceCaptureRef({ info: async () => ({ defaultBranch: 'main' }), log: async () => [] } as unknown as ArtifactsRepo))
    .rejects.toMatchObject({ code: 'INVALID_CAPTURE' });
});
