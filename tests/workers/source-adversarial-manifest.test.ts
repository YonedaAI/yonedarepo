import { reset } from 'cloudflare:test';
import { afterEach, expect, it } from 'vitest';
import {
  denied,
  fingerprint,
  gitFile,
  signed,
  sourceFixture,
} from '../../tools/source-benchmark/workerd-source-fixture';

afterEach(reset);

it('sealed metadata retains unread dependency overlays and pages immutable rows without embedding full source views', async () => {
  const overlay = {
    ...gitFile('src/unread.bin', 12, '9'.repeat(40)),
    content: {
      kind: 'git',
      repository: 'platform/dependency',
      commit: '8'.repeat(40),
      path: 'specialist/original.bin',
      blob: '9'.repeat(40),
    },
  };
  const f = await sourceFixture('unread-overlay', {
    baseline_overrides: [{ path: overlay.path, file: overlay }],
    inputs: [
      { repository: 'platform/source-base', commit: 'a'.repeat(40), tree: 'b'.repeat(40) },
      { repository: 'platform/dependency', commit: '8'.repeat(40), tree: '7'.repeat(40) },
    ],
  });
  await f.rpc({
    op: 'source_chmod',
    request_id: 'touch-readable',
    path: 'src/read.bin',
    mode: '100755',
    expected_workspace_version: 0,
    expected_file_version: 0,
  });
  const checkpoint = await f.rpc({
    op: 'source_checkpoint',
    request_id: 'overlay-checkpoint',
    expected_workspace_version: 1,
  });
  const seal = await f.rpc({
    op: 'source_seal',
    request_id: 'overlay-seal',
    expected_workspace_version: 1,
    checkpoint_id: checkpoint.checkpoint_id,
    expected_checkpoint_digest: checkpoint.changeset_digest,
  });
  expect(seal).toMatchObject({
    change_count: 1,
    baseline_override_count: 1,
    authority: 'staged_source',
  });
  expect(seal.changeset).toBeUndefined();
  expect(seal.changeset_header.changes).toBeUndefined();
  expect(seal.changeset_header.baseline_overrides).toBeUndefined();
  const changes = await f.rpc({
    op: 'source_manifest',
    checkpoint_id: checkpoint.checkpoint_id,
    section: 'changes',
    limit: 1,
  });
  const overlays = await f.rpc({
    op: 'source_manifest',
    checkpoint_id: checkpoint.checkpoint_id,
    section: 'baseline_overrides',
    limit: 1,
  });
  expect(changes.items.map((item: any) => item.path)).toEqual(['src/read.bin']);
  expect(overlays.items).toEqual([{ path: overlay.path, file: overlay }]);
  expect(await f.rpc({ op: 'source_stat', path: overlay.path })).toMatchObject({
    content: overlay.content,
    file_version: 0,
  });
  const reconstructed = {
    ...seal.changeset_header,
    changes: changes.items,
    baseline_overrides: overlays.items,
  };
  expect(await fingerprint(reconstructed)).toBe(seal.changeset_digest);
  await denied(
    f.rpc({
      op: 'source_manifest',
      checkpoint_id: checkpoint.checkpoint_id,
      section: 'changes',
      _actor: await f.actor(Date.now() + 60000, { purpose: 'source' }),
    }),
  );
});

it('capture capability reads only its exact sealed checkpoint after producer expiry and cannot mutate or resurrect source authority', async () => {
  const f = await sourceFixture('capture-grant');
  const checkpoint = await f.rpc({
    op: 'source_checkpoint',
    request_id: 'checkpoint',
    expected_workspace_version: 0,
  });
  const seal = await f.rpc({
    op: 'source_seal',
    request_id: 'seal',
    expected_workspace_version: 0,
    checkpoint_id: checkpoint.checkpoint_id,
    expected_checkpoint_digest: checkpoint.changeset_digest,
  });
  const claims = {
    version: 1,
    workspace_id: f.binding.workspace_id,
    binding_digest: await fingerprint(f.binding),
    seal_id: seal.seal_id,
    checkpoint_id: seal.checkpoint_id,
    changeset_digest: seal.changeset_digest,
    capture_job_id: 'capture:fixture',
    capture_epoch: 1,
    expires_at: Date.now() + 60000,
    purpose: 'read_manifest',
  };
  const grant = await signed(claims, 'capture');
  const command = {
    op: 'source_manifest',
    checkpoint_id: seal.checkpoint_id,
    section: 'view_files',
    limit: 1,
    _capture_grant: grant,
    _actor: await f.actor(Date.now() - 1),
  };
  const first = await f.rpc(command);
  expect(first.items).toHaveLength(1);
  expect(first.has_more).toBe(true);
  const second = await f.rpc({ ...command, after: first.next_cursor });
  expect(second.items).toHaveLength(1);
  expect(second.items[0].path).not.toBe(first.items[0].path);
  for (const override of [
    { workspace_id: 'source-workspace:' + '0'.repeat(64) },
    { checkpoint_id: 'checkpoint:foreign' },
    { changeset_digest: '0'.repeat(64) },
    { expires_at: Date.now() - 1 },
  ])
    await denied(
      f.rpc({ ...command, _capture_grant: await signed({ ...claims, ...override }, 'capture') }),
    );
  for (const op of ['source_status', 'source_checkpoint', 'source_write', 'source_seal'])
    await denied(f.rpc({ ...command, op }));
  expect(await f.rpc({ op: 'source_status' })).toMatchObject({
    status: 'sealed',
    workspace_version: 0,
    checked: false,
    published: false,
  });
});
