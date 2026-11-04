// CI routing and its final release aggregate. No network, secrets or deployment capability.
import { appendFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const RELEASE_JOBS = ['scope', 'ship-tree', 'check', 'wasm', 'workers-total', 'suites', 'image'];
const REQUIRED = ['scope', 'ship-tree', 'check'];
export function releasePasses(needs) {
  if (!REQUIRED.every(id => needs?.[id]?.result === 'success')) return false;
  const { tooling, full } = needs.scope.outputs ?? {};
  if (tooling === 'false' && full === 'true')
    return RELEASE_JOBS.every(id => needs[id]?.result === 'success');
  return tooling === 'true' && full === 'false' && RELEASE_JOBS
    .filter(id => !REQUIRED.includes(id)).every(id => needs[id]?.result === 'skipped');
}

/** Only known tooling paths may avoid application validation; unknown history runs full. */
export const onlyTooling = paths => Array.isArray(paths) && paths.length > 0 && paths.every(path =>
  typeof path === 'string' && !/[\\\u0000-\u001f\u007f]/.test(path) &&
  !path.split('/').some(part => part === '.' || part === '..' || part === '') &&
  (/^(xtask|\.github|tools\/(ci|ship)|tests\/runtime|docs)\//.test(path) || /^[^/]+\.md$/.test(path)),
);
export function validationScope(paths, { release = false, manualFull = false } = {}) {
  const tooling = onlyTooling(paths) && !manualFull;
  return { tooling, full: manualFull || (release && !tooling) };
}
export function changedPaths(base, head, git = execFileSync) {
  if (!/^[0-9a-f]{40}$/.test(base ?? '') || !/^[0-9a-f]{40}$/.test(head ?? '')) return null;
  try {
    // Deleting application code by renaming it into docs is still an application change.
    return git('git', ['diff', '--no-renames', '--name-only', '-z', base, head],
      { stdio: ['ignore', 'pipe', 'ignore'] }).toString().split('\0').filter(Boolean);
  } catch { return null; }
}
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
    const { BASE, HEAD, FORCE, RELEASE, MANUAL_FULL, GITHUB_OUTPUT } = process.env;
    const paths = changedPaths(BASE, HEAD);
    const scope = validationScope(paths, { release: RELEASE === 'true', manualFull: MANUAL_FULL === 'true' });
    appendFileSync(GITHUB_OUTPUT, `check=${checkNeeded(paths, FORCE === 'true')}\ntooling=${scope.tooling}\nfull=${scope.full}\n`);
  }
}
