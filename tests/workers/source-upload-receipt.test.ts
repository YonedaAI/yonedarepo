import { reset } from 'cloudflare:test';
import { afterEach, expect, it } from 'vitest';
import { sourceUpload } from '../../cloudflare/worker/source-upload';
import {
  bindings,
  sha256,
  sourceFixture,
} from '../../tools/source-benchmark/workerd-source-fixture';

afterEach(reset);

// The native source client fences an upload unless the broker's verified value names the
// workspace version it reserved against and the staged-source authority.
it('the actual Wasm authority returns the upload and per-file write receipts the source client verifies', async () => {
  const f = await sourceFixture('upload-receipt');
  const other = await f.rpc({
    op: 'source_chmod',
    request_id: 'mode-unread',
    path: 'src/unread.bin',
    mode: '100755',
    expected_workspace_version: 0,
    expected_file_version: 0,
  });
  expect(other.workspace_version).toBe(1);
  expect(other.file_versions).toEqual({ 'src/unread.bin': 1 });
  const bytes = new Uint8Array([1, 2, 3, 4, 5]);
  const context = {
    binding: f.binding,
    view: f.view,
    baseline_overrides: [],
    mount: 'repo',
    actor: await f.actor(Date.now() + 60000, { purpose: 'source' }),
  };
  const uploaded = await sourceUpload(
    bindings,
    context as any,
    { ...context, actor: await f.actor() } as any,
    {
      request_id: 'write-read-upload',
      path: 'src/read.bin',
      sha256: await sha256(bytes),
      size: bytes.length,
      mode: '100644',
      expected_workspace_version: 1,
      expected_file_version: 0,
    },
    new Blob([bytes]).stream(),
  );
  expect(uploaded).toMatchObject({
    version: 1,
    workspace_id: f.binding.workspace_id,
    workspace_version: 1,
    authority: 'staged_source',
    ticket: { path: 'src/read.bin', state: 'verified' },
  });
  expect(uploaded.ticket.key).toBeUndefined();
  const write = await f.rpc({
    op: 'source_write',
    request_id: 'write-read',
    path: 'src/read.bin',
    ticket_id: uploaded.ticket.id,
    expected_workspace_version: 1,
    expected_file_version: 0,
  });
  // File versions advance per path; the workspace version does not define them.
  expect(write.workspace_version).toBe(2);
  expect(write.file_versions).toEqual({ 'src/read.bin': 1 });
});
