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
/** Every harness and the providers it drives, with each agent's default model among them. */
const CASES = [
  'claude-code/claude/claude-sonnet-5-5',
  'claude-code/zai/glm-5.3-flash',
  'codex/codex/gpt-5.6-luna',
  'opencode/zai/glm-5.3-flash',
  'opencode/mimo/mimo-v2.6-flash',
];
try {
  const inside = readFileSync(new URL('./managed-harness-smoke/inside.mjs', import.meta.url));
  let failed = 0;
  for (const smokeCase of CASES) {
    const smoke = run(
      ['run', '--rm', '-i', '--network', 'none', '-e', `SMOKE_CASE=${smokeCase}`, '--entrypoint', 'node', tag, '--input-type=module', '-'],
      { input: inside, stdio: ['pipe', 'inherit', 'inherit'] },
    );
    if (smoke.status !== 0) failed++;
  }
  console.log(`harness smoke: ${CASES.length - failed}/${CASES.length} passed`);
  process.exitCode = failed ? 1 : 0;
} finally {
  if (!keep) run(['image', 'rm', '-f', tag], { stdio: 'ignore' });
}
