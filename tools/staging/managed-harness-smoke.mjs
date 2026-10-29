#!/usr/bin/env node
// Local Docker smoke of the managed agents' harness image: builds it for this machine, runs
// managed-harness-smoke/inside.mjs in it with no network (`--network none`, nothing mounted, a
// throwaway HOME, no credentials), and removes the image afterwards. The real pinned CLIs talk
// to a fake gateway inside the container; no model is called.
//   node tools/staging/managed-harness-smoke.mjs [--keep-image]
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const tag = `yoneda-managed-harness-smoke:${process.pid}`;
const keep = process.argv.includes('--keep-image');
const run = (args, opts = {}) => spawnSync('docker', args, { stdio: 'inherit', ...opts });

const built = run(['build', '-f', 'cloudflare/containers/harness/Dockerfile', '-t', tag, '.'], { cwd: root });
if (built.status !== 0) process.exit(built.status ?? 1);
try {
  const inside = readFileSync(new URL('./managed-harness-smoke/inside.mjs', import.meta.url));
  const smoke = run(['run', '--rm', '-i', '--network', 'none', '--entrypoint', 'node', tag, '--input-type=module', '-'], {
    input: inside,
    stdio: ['pipe', 'inherit', 'inherit'],
  });
  process.exitCode = smoke.status ?? 1;
} finally {
  if (!keep) run(['image', 'rm', '-f', tag], { stdio: 'ignore' });
}
