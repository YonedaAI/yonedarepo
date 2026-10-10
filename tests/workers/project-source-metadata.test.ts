import { env } from 'cloudflare:workers';
import { expect, it } from 'vitest';
import { validateSourceMetadata } from '../../cloudflare/worker/artifacts';
import type { Env } from '../../cloudflare/worker/types';

it('validates large imported sources without constructing the legacy flattened workspace', async () => {
  let bodyReads = 0;
  const remote = {
    [Symbol.dispose]() {},
    readCommit: async () => ({ treeHash: 'b'.repeat(40) }),
    readTree: async () =>
      Array.from({ length: 501 }, (_, index) => ({
        name: `file-${index.toString().padStart(4, '0')}.dat`,
        type: 'blob',
        hash: index.toString(16).padStart(40, '0'),
      })),
    readBlob: async () => {
      bodyReads++;
      return new Blob(['x'.repeat(17_000)]);
    },
  };
  const envWithRemote = {
    ...(env as unknown as Env),
    ARTIFACTS: { get: async () => remote },
  } as unknown as Env;
  const result = await validateSourceMetadata(envWithRemote, {
    repository: `${env.ARTIFACTS_NAMESPACE}/metadata-large`,
    commit: 'a'.repeat(40),
  });
  expect(result.files).toBe(501);
  expect(result.bytes).toBe(501 * 17_000);
  expect(bodyReads).toBe(501);
});
