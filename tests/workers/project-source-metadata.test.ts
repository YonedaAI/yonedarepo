import { expect, it } from 'vitest';
import { validateSourceMetadata } from '../../cloudflare/worker/artifacts';
import type { SourceRepo } from '../../cloudflare/worker/source-objects';

it('validates large imported sources from tree metadata without reading file bodies', async () => {
  let bodyReads = 0;
  const repo = {
    repo: 'r'.padEnd(21, '0'),
    readCommit: async (hash: string) => ({ hash, treeHash: 'b'.repeat(40), parents: [] }),
    readTree: async () =>
      Array.from({ length: 501 }, (_, index) => ({
        name: `file-${index.toString().padStart(4, '0')}.dat`,
        type: 'blob' as const,
        mode: '100644',
        hash: index.toString(16).padStart(40, '0'),
      })),
    readBlob: async () => {
      bodyReads++;
      return new Blob(['x'.repeat(17_000)]);
    },
  } as unknown as SourceRepo;
  const result = await validateSourceMetadata(repo, 'a'.repeat(40));
  expect(result).toEqual({ commit: 'a'.repeat(40), tree: 'b'.repeat(40), files: 501 });
  expect(bodyReads).toBe(0);
});
