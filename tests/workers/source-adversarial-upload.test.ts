import { reset } from 'cloudflare:test';
import { afterEach, expect, it } from 'vitest';
import { sourceUpload } from '../../cloudflare/worker/source-upload';
import {
  bindings,
  sha256,
  sourceFixture,
} from '../../tools/source-benchmark/workerd-source-fixture';

afterEach(reset);

it('the real R2 streaming adapter verifies binary bytes before native writes and preserves upload identity after lost acknowledgment', async () => {
  const f = await sourceFixture('stream-upload');
  const bytes = new Uint8Array([0, 255, 192, 128, 10]);
  const args = {
    request_id: 'upload-once',
    path: 'src/read.bin',
    sha256: await sha256(bytes),
    size: bytes.length,
    mode: '100644',
    expected_workspace_version: 0,
    expected_file_version: 0,
  };
  const context = {
    binding: f.binding,
    view: f.view,
    baseline_overrides: [],
    mount: 'repo',
    actor: await f.actor(Date.now() + 60000, { purpose: 'source' }),
  };
  const supervisor = { ...context, actor: await f.actor() };
  const first = await sourceUpload(
    bindings,
    context as any,
    supervisor as any,
    args,
    new Blob([bytes]).stream(),
  );
  expect(first.ticket.key).toBeUndefined();
  expect(first.ticket.state).toBe('verified');
  const replay = await sourceUpload(
    bindings,
    context as any,
    supervisor as any,
    args,
    new Blob([bytes]).stream(),
  );
  expect(replay).toEqual(first);
  const write = await f.rpc({
    op: 'source_write',
    request_id: 'commit-upload',
    path: args.path,
    ticket_id: first.ticket.id,
    expected_workspace_version: 0,
    expected_file_version: 0,
  });
  expect(write.workspace_version).toBe(1);
  const pointer = await f.rpc({ op: 'source_read', path: args.path, expected_file_version: 1 });
  const object = await bindings.OBJECTS.get(pointer.content.key);
  expect(new Uint8Array(await object!.arrayBuffer())).toEqual(bytes);
});

it('wrong streaming bytes cannot become a verified writable ticket and cannot alter the original file', async () => {
  const f = await sourceFixture('stream-corrupt');
  const expected = new Uint8Array([0, 255, 128, 10]);
  const wrong = new Uint8Array([0, 255, 128, 11]);
  const args = {
    request_id: 'corrupt-upload',
    path: 'src/read.bin',
    sha256: await sha256(expected),
    size: expected.length,
    mode: '100644',
    expected_workspace_version: 0,
    expected_file_version: 0,
  };
  const context = {
    binding: f.binding,
    view: f.view,
    baseline_overrides: [],
    mount: 'repo',
    actor: await f.actor(Date.now() + 60000, { purpose: 'source' }),
  };
  const supervisor = { ...context, actor: await f.actor() };
  await expect(
    sourceUpload(bindings, context as any, supervisor as any, args, new Blob([wrong]).stream()),
  ).rejects.toThrow();
  const reserved = await f.rpc({ op: 'source_upload_ticket', ...args, _actor: context.actor });
  await expect(
    f.rpc({
      op: 'source_write',
      request_id: 'cannot-commit-corrupt',
      path: args.path,
      ticket_id: reserved.ticket.id,
      expected_workspace_version: 0,
      expected_file_version: 0,
    }),
  ).rejects.toHaveProperty('code');
  expect((await f.rpc({ op: 'source_status' })).workspace_version).toBe(0);
  expect((await f.rpc({ op: 'source_stat', path: args.path })).content).toEqual(
    f.view.files[0].content,
  );
});
