// CI routing and its final release aggregate. No network, secrets or deployment capability.
import { appendFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const RELEASE_JOBS = ['scope', 'ship-tree', 'check', 'wasm', 'workers-total', 'suites', 'image'];
export const releasePasses = (needs) => RELEASE_JOBS.every((id) => needs?.[id]?.result === 'success');
export const checkNeeded = (paths, force = false) => force || paths === null || paths.some(
  (path) => !path.startsWith('docs/') && !path.startsWith('frontend/src/content/') && !path.endsWith('.md'),
);

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (process.argv[2] === '--gate') {
    let passed = false;
    try { passed = releasePasses(JSON.parse(process.env.VALIDATION_NEEDS ?? 'null')); } catch {}
    if (!passed) { console.error('::error::Release validation did not pass every required job.'); process.exitCode = 1; }
    else console.log('Release validation passed.');
  } else {
    const { BASE, HEAD, FORCE, GITHUB_OUTPUT } = process.env;
    let paths = null;
    if (/^[0-9a-f]{40}$/.test(BASE ?? '') && /^[0-9a-f]{40}$/.test(HEAD ?? '')) {
      try { paths = execFileSync('git', ['diff', '--name-only', '-z', BASE, HEAD], { stdio: ['ignore', 'pipe', 'ignore'] }).toString().split('\0').filter(Boolean); } catch {}
    }
    appendFileSync(GITHUB_OUTPUT, `check=${checkNeeded(paths, FORCE === 'true')}\n`);
  }
}
