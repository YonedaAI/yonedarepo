import { reset } from 'cloudflare:test';
import { afterEach, expect, it } from 'vitest';
import {
  denied,
  sourceFixture,
  verifiedTicket,
} from '../../tools/source-benchmark/workerd-source-fixture';

afterEach(reset);
const bytes = new TextEncoder().encode('changed-source');

it('rejects unsigned, forged, foreign-view and expired actor claims without changing source state', async () => {
  const first = await sourceFixture('authority');
  const other = await sourceFixture('foreign');
  const valid = await first.actor();
  const forged = { ...valid, claims: { ...valid.claims, access: 'read_only' } };
  const unsigned = { claims: valid.claims, signature: '0'.repeat(64) };
  const before = await first.rpc({ op: 'source_status' });
  for (const grant of [
    unsigned,
    forged,
    await other.actor(),
    await first.actor(Date.now() - 1),
    await first.actor(Date.now() + 60000, { epoch: 2 }),
    await first.actor(Date.now() + 60000, { view_digest: '0'.repeat(64) }),
  ]) {
    await denied(
      first.rpc({
        op: 'source_stat',
        path: 'src/read.bin',
        _actor: grant,
        _source_signing_key: '0'.repeat(64),
        provider: 'forged',
        producer: 'forged',
      }),
    );
    expect(await first.rpc({ op: 'source_status' })).toEqual(before);
  }
  expect(before).toMatchObject({
    capabilities: { source_api: 1 },
    authority: 'staged_source',
    checked: false,
    published: false,
  });
});

it('fences read-only reviewers at upload and mutation boundaries and rejects protected or outside-scope paths', async () => {
  const reviewer = await sourceFixture('reviewer', { role: 'reviewer', access: 'read_only' });
  await denied(verifiedTicket(reviewer, 'src/new.bin', bytes));
  for (const operation of [
    { op: 'source_delete', path: 'src/read.bin', expected_file_version: 0 },
    { op: 'source_chmod', path: 'src/read.bin', mode: '100755', expected_file_version: 0 },
    {
      op: 'source_copy',
      from: 'src/read.bin',
      to: 'src/new.bin',
      expected_from_version: 0,
      expected_to_version: 0,
    },
  ])
    await denied(
      reviewer.rpc({
        ...operation,
        request_id: 'reviewer-mutation',
        expected_workspace_version: 0,
      }),
    );
  expect((await reviewer.rpc({ op: 'source_status' })).workspace_version).toBe(0);
  const builder = await sourceFixture('paths');
  for (const path of [
    'tests/protected.bin',
    'outside.bin',
    '../escape',
    '/absolute',
    '.git/config',
    'src/../escape',
  ])
    await denied(verifiedTicket(builder, path, bytes));
  expect((await builder.rpc({ op: 'source_status' })).workspace_version).toBe(0);
});

it('returns only the stored authorized file pointer, never a supplied cache hash or another workspace content reference', async () => {
  const first = await sourceFixture('pointer');
  const other = await sourceFixture('pointer-other');
  const read = await first.rpc({
    op: 'source_read',
    path: 'src/read.bin',
    expected_file_version: 0,
    limit: 4,
  });
  expect(read.content).toEqual(first.view.files[0].content);
  const before = await first.rpc({ op: 'source_status' });
  await denied(
    first.rpc({
      op: 'source_read',
      path: 'src/read.bin',
      expected_file_version: 0,
      _actor: await other.actor(),
      content: {
        kind: 'r2',
        key: 'private/foreign',
        sha256: '0'.repeat(64),
        size: 4,
        ticket_id: 'foreign',
      },
    }),
  );
  await denied(first.rpc({ op: 'source_read', path: '../foreign/file', expected_file_version: 0 }));
  expect(await first.rpc({ op: 'source_status' })).toEqual(before);
});

it('ordinary signed source grants cannot verify an upload or seal a checkpoint', async () => {
  const f = await sourceFixture('purpose');
  const checkpoint = await f.rpc({
    op: 'source_checkpoint',
    request_id: 'checkpoint',
    expected_workspace_version: 0,
  });
  const grant = await f.actor(Date.now() + 60000, { purpose: 'source' });
  await denied(
    f.rpc({
      op: 'source_seal',
      request_id: 'source-cannot-seal',
      expected_workspace_version: 0,
      checkpoint_id: checkpoint.checkpoint_id,
      expected_checkpoint_digest: checkpoint.changeset_digest,
      _actor: grant,
    }),
  );
  expect((await f.rpc({ op: 'source_status' })).status).toBe('open');
  const ticket = await verifiedTicket(f, 'src/read.bin', bytes);
  await denied(
    f.rpc({
      op: 'source_verify_upload',
      request_id: 'source-cannot-verify',
      ticket_id: ticket.id,
      sha256: ticket.sha256,
      size: ticket.size,
      _actor: grant,
    }),
  );
  expect((await f.rpc({ op: 'source_status' })).workspace_version).toBe(0);
});
