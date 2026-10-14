import { evictDurableObject, reset } from 'cloudflare:test';
import { afterEach, expect, it } from 'vitest';
import {
  bindings,
  denied,
  sourceFixture,
  verifiedTicket,
} from '../../tools/source-benchmark/workerd-source-fixture';

afterEach(reset);
const bytes = new TextEncoder().encode('changed-source');

it('replays a committed write after acknowledgment loss and eviction, preserving one version and rejecting changed input', async () => {
  const f = await sourceFixture('lost-ack');
  const ticket = await verifiedTicket(f, 'src/read.bin', bytes);
  const command = {
    op: 'source_write',
    request_id: 'one-write',
    path: 'src/read.bin',
    ticket_id: ticket.id,
    expected_workspace_version: 0,
    expected_file_version: 0,
  };
  const committed = await f.rpc(command);
  expect(committed).toMatchObject({
    workspace_version: 1,
    file_versions: { 'src/read.bin': 1 },
    authority: 'staged_source',
  });
  await evictDurableObject(f.stub);
  expect(await f.rpc(command)).toEqual(committed);
  expect((await f.rpc({ op: 'source_status' })).workspace_version).toBe(1);
  await expect(f.rpc({ ...command, path: 'src/unread.bin' })).rejects.toMatchObject({
    code: 'IDEMPOTENCY_CONFLICT',
  });
  const events = await f.rpc({ op: 'source_events', limit: 200 });
  expect(
    events.items.filter((event: Record<string, unknown>) => event.request_id === 'one-write'),
  ).toHaveLength(1);
});

it('global and file CAS reject stale concurrent writes and tombstone recreation without partial changes', async () => {
  const f = await sourceFixture('cas');
  const first = await verifiedTicket(f, 'src/read.bin', bytes);
  const second = await verifiedTicket(f, 'src/unread.bin', bytes);
  await f.rpc({
    op: 'source_write',
    request_id: 'first-write',
    path: 'src/read.bin',
    ticket_id: first.id,
    expected_workspace_version: 0,
    expected_file_version: 0,
  });
  await expect(
    f.rpc({
      op: 'source_write',
      request_id: 'stale-write',
      path: 'src/unread.bin',
      ticket_id: second.id,
      expected_workspace_version: 0,
      expected_file_version: 0,
    }),
  ).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
  expect((await f.rpc({ op: 'source_stat', path: 'src/unread.bin' })).content).toEqual(
    f.view.files[1].content,
  );
  await expect(
    f.rpc({
      op: 'source_chmod',
      request_id: 'wrong-file-version',
      path: 'src/read.bin',
      mode: '100755',
      expected_workspace_version: 1,
      expected_file_version: 0,
    }),
  ).rejects.toMatchObject({ code: 'FILE_VERSION_CONFLICT' });
  await f.rpc({
    op: 'source_delete',
    request_id: 'delete',
    path: 'src/read.bin',
    expected_workspace_version: 1,
    expected_file_version: 1,
  });
  const deleted = await f.rpc({ op: 'source_stat', path: 'src/read.bin' });
  expect(deleted).toMatchObject({ exists: false, kind: 'missing', file_version: 2 });
  await expect(verifiedTicket(f, 'src/read.bin', bytes, 2, 0)).rejects.toMatchObject({
    code: 'FILE_VERSION_CONFLICT',
  });
  expect((await f.rpc({ op: 'source_status' })).workspace_version).toBe(2);
});

it('version-bound list cursors and rename collision failures preserve the current tree atomically', async () => {
  const f = await sourceFixture('rename-cursor');
  const listed = await f.rpc({
    op: 'source_list',
    recursive: true,
    limit: 1,
    expected_workspace_version: 0,
  });
  expect(listed.next_cursor).not.toBeNull();
  const read = await f.rpc({ op: 'source_stat', path: 'src/read.bin' });
  const unread = await f.rpc({ op: 'source_stat', path: 'src/unread.bin' });
  await denied(
    f.rpc({
      op: 'source_rename',
      request_id: 'collision',
      from: 'src/read.bin',
      to: 'src/unread.bin',
      expected_workspace_version: 0,
      expected_from_version: 0,
      expected_to_version: 0,
      overwrite: false,
    }),
  );
  await denied(
    f.rpc({
      op: 'source_rename',
      request_id: 'protected-destination',
      from: 'src/read.bin',
      to: 'tests/protected.bin',
      expected_workspace_version: 0,
      expected_from_version: 0,
      expected_to_version: 0,
      overwrite: true,
    }),
  );
  expect(await f.rpc({ op: 'source_stat', path: 'src/read.bin' })).toEqual(read);
  expect(await f.rpc({ op: 'source_stat', path: 'src/unread.bin' })).toEqual(unread);
  await f.rpc({
    op: 'source_rename',
    request_id: 'rename',
    from: 'src/read.bin',
    to: 'src/renamed.bin',
    expected_workspace_version: 0,
    expected_from_version: 0,
    expected_to_version: 0,
    overwrite: false,
  });
  await expect(
    f.rpc({
      op: 'source_list',
      recursive: true,
      limit: 1,
      cursor: listed.next_cursor,
      expected_workspace_version: 1,
    }),
  ).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
  expect(await f.rpc({ op: 'source_stat', path: 'src/read.bin' })).toMatchObject({
    kind: 'missing',
    file_version: 1,
  });
  expect((await f.rpc({ op: 'source_stat', path: 'src/renamed.bin' })).content).toEqual(
    read.content,
  );
  expect((await f.rpc({ op: 'source_status' })).workspace_version).toBe(1);
});

it('seals only a current checkpoint, preserves unread Git identities, and never upgrades staged authority', async () => {
  const f = await sourceFixture('seal');
  const ticket = await verifiedTicket(f, 'src/read.bin', bytes);
  await f.rpc({
    op: 'source_write',
    request_id: 'changed',
    path: 'src/read.bin',
    ticket_id: ticket.id,
    expected_workspace_version: 0,
    expected_file_version: 0,
  });
  const checkpoint = await f.rpc({
    op: 'source_checkpoint',
    request_id: 'checkpoint',
    expected_workspace_version: 1,
  });
  expect(checkpoint.change_count).toBe(1);
  const manifest = await f.rpc({
    op: 'source_manifest',
    checkpoint_id: checkpoint.checkpoint_id,
    section: 'changes',
    limit: 200,
  });
  expect(manifest.items).toHaveLength(1);
  expect(manifest.items[0]).toMatchObject({
    path: 'src/read.bin',
    before: f.view.files[0],
    after: {
      content: { kind: 'r2', key: ticket.key, sha256: ticket.sha256, ticket_id: ticket.id },
    },
  });
  expect(
    (await f.rpc({ op: 'source_read', path: 'src/unread.bin', expected_file_version: 0 })).content,
  ).toEqual(f.view.files[1].content);
  const command = {
    op: 'source_seal',
    request_id: 'seal',
    expected_workspace_version: 1,
    checkpoint_id: checkpoint.checkpoint_id,
    expected_checkpoint_digest: checkpoint.changeset_digest,
  };
  const receipt = await f.rpc(command);
  await evictDurableObject(f.stub);
  expect(await f.rpc(command)).toEqual(receipt);
  expect(
    await f.rpc({
      op: 'source_checkpoint',
      request_id: 'checkpoint',
      expected_workspace_version: 1,
    }),
  ).toEqual(checkpoint);
  await denied(
    f.rpc({
      op: 'source_delete',
      request_id: 'after-seal',
      path: 'src/unread.bin',
      expected_workspace_version: 1,
      expected_file_version: 0,
    }),
  );
  const status = await f.rpc({ op: 'source_status' });
  expect(status).toMatchObject({
    status: 'sealed',
    workspace_version: 1,
    authority: 'staged_source',
    checked: false,
    published: false,
  });
  expect(receipt.changeset_header.parents).toEqual([f.binding.base.commit]);
  expect(manifest.items.map((change: Record<string, unknown>) => change.path)).toEqual([
    'src/read.bin',
  ]);
  expect(await bindings.OBJECTS.head(ticket.key)).not.toBeNull();
});

it('keeps file counters independent of the workspace clock when another path changes first', async () => {
  const f = await sourceFixture('global-file-clock');
  await f.rpc({
    op: 'source_chmod',
    request_id: 'first-path',
    path: 'src/read.bin',
    mode: '100755',
    expected_workspace_version: 0,
    expected_file_version: 0,
  });
  const receipt = await f.rpc({
    op: 'source_chmod',
    request_id: 'second-path',
    path: 'src/unread.bin',
    mode: '100755',
    expected_workspace_version: 1,
    expected_file_version: 0,
  });
  expect(receipt).toMatchObject({ workspace_version: 2, file_versions: { 'src/unread.bin': 1 } });
  expect(await f.rpc({ op: 'source_stat', path: 'src/unread.bin' })).toMatchObject({
    file_version: 1,
  });
  expect(
    await f.rpc({
      op: 'source_chmod',
      request_id: 'second-path-again',
      path: 'src/unread.bin',
      mode: '100644',
      expected_workspace_version: 2,
      expected_file_version: 1,
    }),
  ).toMatchObject({ workspace_version: 3, file_versions: { 'src/unread.bin': 2 } });
});
