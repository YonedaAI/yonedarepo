#!/usr/bin/env node
// N4 platform benchmark runner: builds the Rust Worker, runs the workerd load test and
// writes machine-stamped evidence to .local/platform-load/evidence.json. Offline; no
// deployment, provider keys or containers.
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { arch, cpus, platform, totalmem } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const output = resolve(root, '.local/platform-load');
const marker = 'YONEDA_PLATFORM_LOAD ';
const build = spawnSync('worker-build', ['--release'], { cwd: resolve(root, 'backend/crates/yoneda-worker'), encoding: 'utf8' });
if (build.status !== 0) throw new Error(`Wasm build failed:\n${build.stderr}`);
const run = spawnSync(
  'npx',
  ['vitest', 'run', '--config', 'tests/workers/vitest.config.ts', 'tests/workers/load-platform.test.ts', '--reporter=verbose'],
  { cwd: root, encoding: 'utf8', env: { ...process.env, NO_COLOR: '1' }, maxBuffer: 64 * 1024 * 1024 },
);
const line = run.stdout.split('\n').find((l) => l.includes(marker));
const result = line ? JSON.parse(line.slice(line.indexOf(marker) + marker.length)) : null;
// Scion S3 gate: a one-file commit's median cost is flat (±20%, 3 ms timer slack).
const s3 = result && result.s3_commit_large.p50_ms <= result.s3_commit_small.p50_ms * 1.2 + 3;
const evidence = {
  schema: 1,
  passed: run.status === 0 && result !== null && s3,
  gates: result && {
    commit_acceptance_p95_under_1s: result.commits.p95_ms < 1000,
    warm_reads_p95_under_1s: result.reads.p95_ms < 1000,
    all_landings_succeeded: result.land_failures.length === 0,
    s3_flat_commit_cost: s3,
  },
  recorded_at: new Date().toISOString(),
  revision: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
  dirty_worktree: !!execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim(),
  machine: { platform: platform(), arch: arch(), cpu: cpus()[0]?.model, logical_cpus: cpus().length, memory_bytes: totalmem(), node: process.version },
  note: 'Local workerd (Miniflare): one process, simulated DO/R2 latency; not a hosted measurement.',
  result,
};
await mkdir(output, { recursive: true, mode: 0o700 });
await writeFile(resolve(output, 'evidence.json'), `${JSON.stringify(evidence, null, 2)}\n`);
console.log(JSON.stringify(evidence, null, 2));
process.exit(evidence.passed ? 0 : 1);
