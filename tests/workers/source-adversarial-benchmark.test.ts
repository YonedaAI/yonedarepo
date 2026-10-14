import { reset } from 'cloudflare:test';
import { afterEach, expect, it } from 'vitest';
import { preparedSourceView, sourceIndexBounded } from '../../cloudflare/worker/source-index';
import { verifySourceView } from '../../cloudflare/worker/source-view-proof';
import { sourceReadResponse } from '../../cloudflare/worker/source-storage';
import { fixtureBytes } from '../../tools/source-benchmark/content.mjs';
import { artifactsBenchmarkFixture } from '../../tools/source-benchmark/workerd-artifacts-fixture';
import {
  bindings,
  sourceFixture,
  verifiedTicket,
} from '../../tools/source-benchmark/workerd-source-fixture';

afterEach(reset);

it('separates cold indexing, full-view proof and Native authority initialization and five agent reads, sealing only one changed file', async () => {
  const artifacts = artifactsBenchmarkFixture();
  expect(artifacts.base.tree).toBe('b4ad5a8a767c8c00fa9e0e17cfa243535ef17071');
  const local = { ...bindings, ARTIFACTS: artifacts.artifacts };
  const coldStart = performance.now();
  let batches = 0;
  for (;;) {
    const progress = await sourceIndexBounded(local, artifacts.base);
    batches++;
    expect(progress.state).not.toBe('failed');
    if (progress.state === 'prepared') break;
    if (batches > 1200) throw new Error('Bounded index did not converge');
  }
  const view = await preparedSourceView(local, artifacts.base);
  const coldIndexMs = performance.now() - coldStart;
  const cold = artifacts.counts();
  expect(view.files).toHaveLength(10000);
  expect(cold.blob_reads).toBe(10000);
  expect(cold.blob_bytes).toBe(40960000);
  const certifiedOps = { get: 0, head: 0, metadata_bytes: 0 };
  const certifiedEnv = {
    ...local,
    OBJECTS: new Proxy(bindings.OBJECTS, {
      get(target, key) {
        const member = Reflect.get(target, key, target);
        return typeof member === 'function'
          ? async (...args: unknown[]) => {
              if (key === 'get' || key === 'head') certifiedOps[key]++;
              const result = await Reflect.apply(member, target, args);
              if (key === 'get' && result) certifiedOps.metadata_bytes += result.size;
              return result;
            }
          : member;
      },
    }),
  };
  const certifiedStart = performance.now();
  expect(await preparedSourceView(certifiedEnv, artifacts.base)).toEqual(view);
  const certifiedMs = performance.now() - certifiedStart;
  expect(certifiedOps.head).toBe(0);
  expect(certifiedOps.get).toBeLessThan(1000);
  expect(artifacts.counts().blob_reads).toBe(cold.blob_reads);
  const verificationOps = { get: 0, head: 0 };
  const measured = {
    ...local,
    OBJECTS: new Proxy(bindings.OBJECTS, {
      get(target, key) {
        const member = Reflect.get(target, key, target);
        return typeof member === 'function'
          ? (...args: unknown[]) => {
              if (key === 'get' || key === 'head') verificationOps[key]++;
              return Reflect.apply(member, target, args);
            }
          : member;
      },
    }),
  };
  const verificationStart = performance.now();
  await verifySourceView(measured, view);
  const verificationMs = performance.now() - verificationStart;
  expect(verificationOps).toEqual({ get: 10000, head: 10000 });
  const readyStart = performance.now();
  const f = await sourceFixture('benchmark-10k', {
    files: view.files,
    base: artifacts.base,
    write_paths: ['**'],
    protected_paths: [],
  });
  expect(await f.rpc({ op: 'source_status' })).toMatchObject({
    status: 'open',
    workspace_version: 0,
  });
  const readyMs = performance.now() - readyStart;
  let delivered = 0;
  for (const path of artifacts.requested) {
    const read = await f.rpc({ op: 'source_read', path, expected_file_version: 0, limit: 4096 });
    const response = await sourceReadResponse(local, f.binding, read);
    const bytes = new Uint8Array(await response.arrayBuffer());
    expect(bytes).toEqual(new Uint8Array(fixtureBytes('yoneda-source-api-v1', path, 4096)));
    delivered += bytes.length;
    expect(decodeURIComponent(response.headers.get('x-yoneda-source')!)).not.toContain('content');
  }
  expect(delivered).toBe(20480);
  expect(artifacts.counts().blob_reads).toBe(cold.blob_reads);
  const unread = view.files.find((file) => !artifacts.requested.includes(file.path))!;
  const before = await f.rpc({ op: 'source_stat', path: unread.path });
  const changed = fixtureBytes('yoneda-source-api-v1', artifacts.requested[0], 4096, 'changed');
  const ticket = await verifiedTicket(f, artifacts.requested[0], changed);
  await f.rpc({
    op: 'source_write',
    request_id: 'benchmark-change',
    path: artifacts.requested[0],
    ticket_id: ticket.id,
    expected_workspace_version: 0,
    expected_file_version: 0,
  });
  const checkpoint = await f.rpc({
    op: 'source_checkpoint',
    request_id: 'benchmark-checkpoint',
    expected_workspace_version: 1,
  });
  const sealed = await f.rpc({
    op: 'source_seal',
    request_id: 'benchmark-seal',
    expected_workspace_version: 1,
    checkpoint_id: checkpoint.checkpoint_id,
    expected_checkpoint_digest: checkpoint.changeset_digest,
  });
  expect(sealed.change_count).toBe(1);
  const page = await f.rpc({
    op: 'source_manifest',
    checkpoint_id: checkpoint.checkpoint_id,
    section: 'changes',
    limit: 200,
  });
  expect(page.items).toHaveLength(1);
  expect(page.items[0]).toMatchObject({ path: artifacts.requested[0], after: { size: 4096 } });
  expect(sealed.changeset_header.parents).toEqual([artifacts.base.commit]);
  expect(await f.rpc({ op: 'source_stat', path: unread.path })).toEqual(before);
  console.log(
    JSON.stringify({
      benchmark: 'workerd-native-source-and-r2-cache',
      file_count: 10000,
      base: artifacts.base,
      fixture_base_bytes: 40960000,
      cold_index_ms: coldIndexMs,
      cold_index: cold,
      index_batches: batches,
      source_authority_init_ms: readyMs,
      warm_view_verification_ms: verificationMs,
      warm_view_cache_ops: verificationOps,
      certified_view_assembly_ms: certifiedMs,
      certified_view_cache_ops: certifiedOps,
      full_source_scope_measured: false,
      container_startup_measured: false,
      requested_body_bytes: delivered,
      requested_paths: artifacts.requested,
      changed_body_bytes: changed.length,
      changed_paths: [artifacts.requested[0]],
      history_body_reads: 0,
      unrelated_agent_body_reads: 0,
      linux_mount_measured: false,
      git_capture_measured: false,
    }),
  );
}, 180000);
