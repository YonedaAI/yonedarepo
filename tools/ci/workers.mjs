// Run each workerd scenario once in its canonical configuration.
import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { basename, posix, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const BENCHMARKS = new Set(['load-platform.test.ts', 'repo-big-fetch.test.ts']);

/** Match the existing configs, including main's recursive include and platform's flat one. */
export function workerSuites(inventory) {
  if (!Array.isArray(inventory) || inventory.length === 0)
    throw new Error('Worker test inventory must be nonempty');
  const seen = new Set();
  const suites = { main: [], platform: [], benchmarks: [] };
  for (const path of [...inventory].sort()) {
    if (typeof path !== 'string' || !path.startsWith('tests/workers/') ||
        !path.endsWith('.test.ts') || posix.normalize(path) !== path ||
        /[\\\u0000-\u001f\u007f]/.test(path) || seen.has(path))
      throw new Error('Invalid Worker test inventory');
    seen.add(path);
    const name = basename(path);
    const flat = path === `tests/workers/${name}`;
    if (flat && BENCHMARKS.has(name)) suites.benchmarks.push(path);
    else if (flat && /^(repo-|eval-)/.test(name)) {
      suites.platform.push(path);
    } else suites.main.push(path);
  }
  return suites;
}

/** An inspectable invocation; no caller cwd or shell expansion changes test ownership. */
export function workerInvocation(lane, inventory, args = []) {
  if (lane !== 'main' && lane !== 'platform') throw new Error('Unknown Worker test lane');
  const files = workerSuites(inventory)[lane];
  if (files.length === 0) throw new Error('Worker test lane is empty');
  return {
    command: 'pnpm',
    args: [lane === 'platform' ? 'test:platform' : 'test', ...files, ...args],
    options: { cwd: ROOT, shell: false, stdio: 'inherit' },
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const inventory = readdirSync(resolve(ROOT, 'tests/workers'), { recursive: true })
      .filter(path => path.endsWith('.test.ts')).map(path => `tests/workers/${path}`);
    const plan = workerInvocation(process.argv[2], inventory, process.argv.slice(3));
    const result = spawnSync(plan.command, plan.args, plan.options);
    if (result.error) throw result.error;
    process.exitCode = result.status ?? 1;
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
