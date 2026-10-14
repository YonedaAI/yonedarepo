import { reset } from 'cloudflare:test';
import { afterEach, expect, it } from 'vitest';
import { captureResult } from '../../cloudflare/worker/capture-result';
import { ledger } from '../../cloudflare/worker/storage';
import type { Env, Scope } from '../../cloudflare/worker/types';
import { bindings } from '../../tools/source-benchmark/workerd-source-fixture';

afterEach(reset);

it('capture readback rejects a different returned commit hash before storing capture evidence', async () => {
  const base = 'a'.repeat(40),
    requested = 'c'.repeat(40),
    tree = 'd'.repeat(40);
  await ledger(bindings, 'source-capture-hash', {
    op: 'init',
    id: 'source-capture-hash',
    name: 'Readback identity fixture',
    remote: { namespace: 'yoneda-test', name: 'source-capture-hash' },
    commit: base,
    policy: {
      version: 'v1',
      required_checks: ['retry'],
      suite: 'retry-contract-v1',
      environment: 'linux-rust-1.94-v1',
    },
  });
  const sdk = {
    [Symbol.dispose]() {},
    readCommit: async (commit: string) =>
      commit === requested
        ? { hash: 'f'.repeat(40), treeHash: tree, parents: [base] }
        : { hash: base, treeHash: 'b'.repeat(40), parents: [] },
    readTree: async () => [{ name: 'file.txt', type: 'blob', hash: 'e'.repeat(40) }],
  };
  const env = { ...bindings, ARTIFACTS: { get: async () => sdk } } as unknown as Env;
  const scope = {
    repo_id: 'source-capture-hash',
    fork: 'yoneda-test/frozen-fork',
    job: {
      id: 'capture-fixture',
      kind: 'capture',
      epoch: 1,
      payload: { base: { repository: 'yoneda-test/source-capture-hash', commit: base } },
    },
  } as Scope;
  await expect(
    captureResult(env, scope, {
      id: 'candidate',
      revision: { repository: scope.fork, commit: requested },
      tree,
      parents: [base],
      diff: 'Synthetic SDK readback only; no Git push',
    }),
  ).rejects.toMatchObject({ code: 'INVALID_CAPTURE' });
  expect((await bindings.OBJECTS.list()).objects).toHaveLength(0);
});
