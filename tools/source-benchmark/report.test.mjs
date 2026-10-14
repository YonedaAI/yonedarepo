import assert from 'node:assert/strict';
import { test } from 'node:test';
import { benchmarkReport } from './report.mjs';
const commit = 'a'.repeat(40),
  tree = 'b'.repeat(40);
const clone = {
  kind: 'local-full-git-clone',
  commit,
  tree,
  fixture_files: 10000,
  checkout_bytes: 40960000,
  packed_git_object_bytes: 41352864,
  clone_ms: 2700,
  history_commits: 3,
};
const delta = {
  kind: 'local-git-delta-case',
  parent: commit,
  parent_tree: tree,
  changed_paths: ['data/000/00000.bin'],
  changed_bytes: 4096,
  object_closure: {
    counts: { blob: 1, tree: 3, commit: 1 },
    blob_bytes: 4096,
    ancestor_metadata_bytes: 7041,
    pack_bytes: 9226,
    recipient_base_required: commit,
  },
};
const source = {
  benchmark: 'workerd-native-source-and-r2-cache',
  base: { commit, tree },
  file_count: 10000,
  fixture_base_bytes: 40960000,
  cold_index_ms: 18000,
  source_authority_init_ms: 120,
  cold_index: { blob_bytes: 40960000 },
  warm_view_verification_ms: 100,
  warm_view_cache_ops: { get: 10000, head: 10000 },
  requested_body_bytes: 20480,
  requested_paths: [
    'data/000/00000.bin',
    'data/024/02499.bin',
    'data/049/04999.bin',
    'data/074/07499.bin',
    'data/099/09999.bin',
  ],
  changed_body_bytes: 4096,
  changed_paths: ['data/000/00000.bin'],
  history_body_reads: 0,
  unrelated_agent_body_reads: 0,
  linux_mount_measured: false,
  git_capture_measured: false,
  full_source_scope_measured: false,
  container_startup_measured: false,
};
test('reports each actual byte denominator and does not hide cold preparation in a warm startup comparison', () => {
  const report = benchmarkReport(clone, delta, source);
  assert.equal(report.agent_bodies.numerator_bytes, 20480);
  assert.equal(report.agent_bodies.denominator_current_source_bytes, 40960000);
  assert.equal(report.agent_bodies.fraction, 0.0005);
  assert.equal(report.cold_preparation.fraction_of_current_source, 1);
  assert.equal(report.prelaunch_components.cold_plus_native_init_ms, 18120);
  assert.equal(report.delta_pack.denominator_full_clone_pack_bytes, 41352864);
  assert.equal(report.delta_pack.numerator_bytes, 9226);
  assert.equal(report.delta_pack.ancestor_metadata_bytes, 7041);
  assert.equal(report.linux_mount_measured, false);
  assert.equal(report.production_capture_measured, false);
});
test('rejects comparison of different frozen authorities or fictional unrelated read savings', () => {
  assert.throws(() => benchmarkReport({ ...clone, tree: 'c'.repeat(40) }, delta, source));
  assert.throws(() => benchmarkReport(clone, delta, { ...source, unrelated_agent_body_reads: 1 }));
  assert.throws(() =>
    benchmarkReport(clone, delta, { ...source, requested_paths: ['same', 'same'] }),
  );
});
