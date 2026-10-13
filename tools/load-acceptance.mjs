#!/usr/bin/env node
// Offline, bounded authority benchmark. No deployment, provider keys, inference, or containers.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { arch, cpus, platform, totalmem } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadMarker } from './load-metrics.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const output = resolve(root, '.local/load-acceptance');
const environment = Object.fromEntries(
  ['PATH', 'HOME', 'TMPDIR', 'CARGO_HOME', 'RUSTUP_HOME', 'RUSTUP_TOOLCHAIN']
    .filter((key) => process.env[key])
    .map((key) => [key, process.env[key]]),
);
Object.assign(environment, {
  CARGO_NET_OFFLINE: 'true',
  WRANGLER_SEND_METRICS: 'false',
  NO_COLOR: '1',
});

async function run(command, args, cwd = root, timeoutMs = 180_000) {
  return await new Promise((accept, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: environment,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
    }, timeoutMs);
    const force = setTimeout(() => child.kill('SIGKILL'), timeoutMs + 5000);
    child.stdout.on('data', (part) => {
      stdout += part;
    });
    child.stderr.on('data', (part) => {
      stderr += part;
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      clearTimeout(force);
      reject(error);
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      clearTimeout(force);
      accept({ code, signal, timed_out: timedOut, stdout, stderr });
    });
  });
}

function markers(stdout, marker) {
  return stdout
    .split('\n')
    .filter((line) => line.includes(marker))
    .map((line) => JSON.parse(line.slice(line.indexOf(marker) + marker.length)));
}

async function sourceDigest() {
  const files = await run('git', [
    'ls-files',
    'backend',
    'cloudflare/worker',
    'shared',
    'tests/workers',
    'tools/*load*',
    'tests/runtime/*load*',
  ]);
  if (files.code !== 0) throw new Error('Cannot identify source inputs');
  const benchmarkFiles = [
    'Cargo.toml',
    'Cargo.lock',
    'rust-toolchain.toml',
    'package.json',
    'pnpm-lock.yaml',
    'tools/load-acceptance.mjs',
    'tools/load-metrics.mjs',
    'tests/workers/load-fixture.ts',
    'tests/workers/load-authority.test.ts',
    'tests/workers/load-recovery.test.ts',
    'tests/runtime/load-metrics.test.mjs',
  ];
  const hash = createHash('sha256');
  for (const name of [...new Set([...files.stdout.trim().split('\n'), ...benchmarkFiles])].sort()) {
    hash.update(`${name}\0`);
    hash.update(await readFile(resolve(root, name)));
    hash.update('\0');
  }
  return hash.digest('hex');
}

async function main() {
  if (process.argv.length !== 2)
    throw new Error('Usage: node tools/load-acceptance.mjs (fixed bounded sweep)');
  await mkdir(output, { recursive: true, mode: 0o700 });
  const began = Date.now();
  const revision = await run('git', ['rev-parse', 'HEAD']);
  const status = await run('git', ['status', '--porcelain']);
  const rust = await run('rustc', ['--version']);
  const pnpm = await run('pnpm', ['--version']);
  const digest = await sourceDigest();
  console.log('Building the current Rust Worker offline before exercising real workerd SQLite.');
  const build = await run(
    'worker-build',
    ['--release'],
    resolve(root, 'backend/crates/yoneda-worker'),
  );
  const wasmDigest =
    build.code === 0
      ? createHash('sha256')
          .update(await readFile(resolve(root, 'backend/crates/yoneda-worker/build/index_bg.wasm')))
          .digest('hex')
      : null;
  const metricsTests = await run('node', ['--test', 'tests/runtime/load-metrics.test.mjs']);
  const execution =
    build.code === 0 && metricsTests.code === 0
      ? await run('pnpm', [
          'exec',
          'vitest',
          'run',
          '--config',
          'tests/workers/vitest.config.ts',
          'tests/workers/load-authority.test.ts',
          'tests/workers/load-recovery.test.ts',
          '--fileParallelism=false',
        ])
      : { code: null, timed_out: false, stdout: '' };
  const results = markers(execution.stdout, loadMarker);
  const audits = markers(execution.stdout, 'YONEDA_LOAD_AUDIT ');
  const passed =
    build.code === 0 &&
    metricsTests.code === 0 &&
    execution.code === 0 &&
    results.length === 5 &&
    audits.length === 4 &&
    results.every((result) => result.workload_passed && result.metrics.unexpected_errors === 0) &&
    audits.every((audit) => audit.passed);
  const evidence = {
    schema: 1,
    passed,
    recorded_at: new Date().toISOString(),
    wall_ms: Date.now() - began,
    revision: revision.stdout.trim(),
    dirty_worktree: !!status.stdout.trim(),
    source_sha256_before: digest,
    source_sha256_after: await sourceDigest(),
    wasm_sha256: wasmDigest,
    machine: {
      platform: platform(),
      arch: arch(),
      logical_cpus: cpus().length,
      cpu: cpus()[0]?.model,
      memory_bytes: totalmem(),
      node: process.version,
      rust: rust.stdout.trim(),
      pnpm: pnpm.stdout.trim(),
    },
    command: 'node tools/load-acceptance.mjs',
    steps: {
      wasm_build_exit: build.code,
      metrics_tests_exit: metricsTests.code,
      workerd_tests_exit: execution.code,
      build_timed_out: build.timed_out,
      workerd_timed_out: execution.timed_out,
    },
    authority:
      'Current production Rust Wasm commands and migrations in local workerd Durable Object SQLite',
    transport:
      'Direct storage.ledger -> DO stub.fetch; excludes browser, authentication and public HTTP network',
    measurement:
      'Closed-loop bounded clients; no think time; submission-to-response latency; nearest-rank p50/p95; no speed pass threshold',
    fixtures: [
      'TestEntrypoint.deliver withholds queue delivery',
      'No actual queue consumer or container launch',
      'Synthetic repository remote/commit identifiers; no Git/build evaluation or paid inference',
      'Recovery incident expires six leases through SQL; production alarm performs recovery',
    ],
    limits: [
      'Single local workerd process on this host',
      'Maximum 16 repositories and 64 in-flight commands',
      'Four waves of four runs per repository; not a soak or saturation search',
      'Warm authority sweep; recovery includes eviction',
      'Undelivered outbox retained by fixture',
      'No deployed scalability, real queue/container throughput, semantic merge quality or context benefit claim',
    ],
    runtime_warnings: {
      unsafe_integer_conversion: (
        execution.stdout.match(/outside the JavaScript safe-integer range/g) ?? []
      ).length,
      note: 'Existing runs_page adapter warning, retained in the measured workload; no authority changes made here',
    },
    results,
    audits,
  };
  await writeFile(resolve(output, 'evidence.json'), `${JSON.stringify(evidence, null, 2)}\n`, {
    mode: 0o600,
  });
  await writeFile(
    resolve(output, `evidence-${evidence.recorded_at.replace(/[:.]/g, '-')}.json`),
    `${JSON.stringify(evidence, null, 2)}\n`,
    { mode: 0o600 },
  );
  for (const result of results) {
    const m = result.metrics;
    console.log(
      `${result.name}: ${m.successful}/${m.attempted} commands successful; ${m.successful_commands_per_second.toFixed(2)} successful/s; ` +
        `p50 ${m.all_latency.p50_ms.toFixed(2)} ms, p95 ${m.all_latency.p95_ms.toFixed(2)} ms; ` +
        `${m.expected_rejections} expected rejections, ${m.unexpected_errors} unexpected errors`,
    );
  }
  console.log(`${passed ? 'PASS' : 'FAIL'}: .local/load-acceptance/evidence.json`);
  if (!passed) {
    console.error(
      `Step exits: Wasm ${build.code}, metrics ${metricsTests.code}, workerd ${execution.code}. ` +
        'Run the two tests/workers/load-*.test.ts files with the existing Vitest config for failure diagnostics.',
    );
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
