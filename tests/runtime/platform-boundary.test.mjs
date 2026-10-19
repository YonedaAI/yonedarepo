// The source platform must not depend on the agent layer (runs, harnesses, providers,
// budgets). Platform modules may import only each other and neutral infrastructure.
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import test from 'node:test';

const worker = 'cloudflare/worker';
const neutral = new Set([
  './auth',
  './http',
  './types',
  './check-container',
  '../../backend/crates/yoneda-worker/build/worker/shim.mjs',
  '../../backend/crates/yoneda-core/src/platform_tools.json',
]);

test('platform adapter modules import only platform and neutral modules', async () => {
  const files = (await readdir(worker)).filter((f) => /^(repo-.*|check-container)\.ts$/.test(f));
  assert.ok(files.length >= 7, files.join());
  for (const file of files) {
    const source = await readFile(`${worker}/${file}`, 'utf8');
    for (const [, target] of source.matchAll(/from '(\.[^']+)'/g)) {
      const allowed = neutral.has(target) || /^\.\/repo-[a-z-]+$/.test(target);
      assert.ok(allowed, `${file} imports ${target}`);
    }
  }
});

test('platform Rust modules use only platform and storage code', async () => {
  const roots = ['backend/crates/yoneda-app/src/repo_store', 'backend/crates/yoneda-app/src'];
  const files = [
    ...(await readdir(roots[0])).map((f) => `${roots[0]}/${f}`),
    `${roots[1]}/repo_store.rs`,
    `${roots[1]}/platform_compute.rs`,
    `${roots[1]}/platform_objects.rs`,
    `${roots[1]}/platform_derived.rs`,
    `${roots[1]}/platform_code.rs`,
    `${roots[1]}/platform_review.rs`,
    `${roots[1]}/platform_symbols.rs`,
  ].filter((f) => f.endsWith('.rs'));
  for (const file of files) {
    const source = await readFile(file, 'utf8');
    for (const [, path] of source.matchAll(/use crate::([a-z_]+)/g))
      assert.ok(['storage', 'repo_store', 'platform_objects', 'platform_derived', 'platform_review', 'platform_symbols', 'native'].includes(path), `${file} uses crate::${path}`);
    for (const [, module] of source.matchAll(/yoneda_core::([a-z_]+)/g))
      assert.ok(
        ['git_object', 'txlog', 'textdiff', 'merge', 'search', 'blame', 'Error', 'Result', 'digest', 'fingerprint', 'validate_path'].includes(module),
        `${file} uses yoneda_core::${module}`,
      );
  }
});
