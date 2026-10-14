import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Compare recorded local measurements only, preserving authority and different denominators. */
export function benchmarkReport(clone, delta, source) {
  if (
    clone.kind !== 'local-full-git-clone' ||
    delta.kind !== 'local-git-delta-case' ||
    source.benchmark !== 'workerd-native-source-and-r2-cache' ||
    clone.commit !== source.base.commit ||
    clone.tree !== source.base.tree ||
    delta.parent !== clone.commit ||
    delta.parent_tree !== clone.tree ||
    clone.fixture_files !== source.file_count ||
    clone.checkout_bytes !== source.fixture_base_bytes ||
    source.history_body_reads !== 0 ||
    source.unrelated_agent_body_reads !== 0 ||
    source.requested_paths.length !== 5 ||
    new Set(source.requested_paths).size !== 5 ||
    source.changed_paths.length !== 1 ||
    source.changed_paths[0] !== delta.changed_paths[0] ||
    delta.changed_bytes !== source.changed_body_bytes ||
    delta.object_closure.blob_bytes !== delta.changed_bytes ||
    delta.object_closure.recipient_base_required !== clone.commit ||
    source.linux_mount_measured !== false ||
    source.git_capture_measured !== false ||
    source.full_source_scope_measured !== false ||
    source.container_startup_measured !== false ||
    source.warm_view_cache_ops?.get !== source.file_count ||
    source.warm_view_cache_ops?.head !== source.file_count
  )
    throw new Error('Measurements do not describe the same verified local fixture');
  const positive = [
    clone.checkout_bytes,
    clone.packed_git_object_bytes,
    source.cold_index_ms,
    source.source_authority_init_ms,
    source.cold_index.blob_bytes,
    source.warm_view_verification_ms,
    source.requested_body_bytes,
    delta.object_closure.pack_bytes,
    delta.object_closure.ancestor_metadata_bytes,
  ];
  if (positive.some((value) => !Number.isFinite(value) || value <= 0))
    throw new Error('Measurement is absent or invalid');
  return {
    version: 1,
    kind: 'local-source-api-benchmark',
    base: source.base,
    file_count: source.file_count,
    cold_preparation: {
      ms: source.cold_index_ms,
      server_blob_bytes: source.cold_index.blob_bytes,
      denominator_current_source_bytes: clone.checkout_bytes,
      fraction_of_current_source: source.cold_index.blob_bytes / clone.checkout_bytes,
    },
    prelaunch_components: {
      native_authority_init_ms: source.source_authority_init_ms,
      warm_full_view_verification_ms: source.warm_view_verification_ms,
      warm_cache_operations: source.warm_view_cache_ops,
      ...(source.certified_view_assembly_ms === undefined
        ? {}
        : {
            certified_view_assembly_ms: source.certified_view_assembly_ms,
            certified_view_cache_operations: source.certified_view_cache_ops,
          }),
      full_source_scope_measured: false,
      container_startup_measured: false,
      cold_plus_native_init_ms: source.cold_index_ms + source.source_authority_init_ms,
      full_clone_ms: clone.clone_ms,
    },
    agent_bodies: {
      numerator_bytes: source.requested_body_bytes,
      denominator_current_source_bytes: clone.checkout_bytes,
      fraction: source.requested_body_bytes / clone.checkout_bytes,
      requested_paths: source.requested_paths,
      history_body_reads: 0,
      unrelated_body_reads: 0,
    },
    delta_pack: {
      kind: 'local-git-delta-case',
      numerator_bytes: delta.object_closure.pack_bytes,
      denominator_full_clone_pack_bytes: clone.packed_git_object_bytes,
      fraction: delta.object_closure.pack_bytes / clone.packed_git_object_bytes,
      changed_body_bytes: delta.changed_bytes,
      ancestor_metadata_bytes: delta.object_closure.ancestor_metadata_bytes,
      objects: delta.object_closure.counts,
      recipient_base_required: clone.commit,
      baseline_history_commits: clone.history_commits,
    },
    linux_mount_measured: false,
    production_capture_measured: false,
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [baselinePath, deltaPath, workerdLogPath, extra] = process.argv.slice(2);
    if (!baselinePath || !deltaPath || !workerdLogPath || extra)
      throw new Error('Usage: report.mjs BASELINE_JSON DELTA_JSON WORKERD_LOG');
    const [baseline, delta, log] = await Promise.all([
      readFile(baselinePath, 'utf8'),
      readFile(deltaPath, 'utf8'),
      readFile(workerdLogPath, 'utf8'),
    ]);
    const line = log
      .split('\n')
      .find((line) => line.startsWith('{"benchmark":"workerd-native-source-and-r2-cache"'));
    if (!line || !/Tests\s+1 passed/.test(log))
      throw new Error('Workerd benchmark did not pass or emit measurements');
    console.log(
      JSON.stringify(
        benchmarkReport(JSON.parse(baseline), JSON.parse(delta), JSON.parse(line)),
        null,
        2,
      ),
    );
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
