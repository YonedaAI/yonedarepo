// The source platform must not depend on the agent layer (runs, harnesses, providers,
// budgets). Platform modules may import only each other and neutral infrastructure.
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import test from 'node:test';

const worker = 'cloudflare/worker';
const neutral = new Set([
  './auth',
  './accounts',
  './http',
  './types',
  './check-container',
  '../../backend/crates/yoneda-worker/build/worker/shim.mjs',
  '../../backend/crates/yoneda-core/src/platform_tools.json',
]);

test('platform adapter modules import only platform and neutral modules', async () => {
  const files = (await readdir(worker)).filter((f) => /^(repo-.*|check-container|platform-.*)\.ts$/.test(f));
  assert.ok(files.length >= 10, files.join());
  for (const file of files) {
    const source = await readFile(`${worker}/${file}`, 'utf8');
    for (const [, target] of source.matchAll(/from '(\.[^']+)'/g)) {
      const allowed = neutral.has(target) || /^\.\/(repo|platform)-[a-z-]+$/.test(target);
      assert.ok(allowed, `${file} imports ${target}`);
    }
  }
});

test('the platform crate depends on core contracts and the store only', async () => {
  const manifest = await readFile('backend/crates/yoneda-platform/Cargo.toml', 'utf8');
  for (const agent of ['yoneda-app', 'yoneda-runtime', 'yoneda-cloudflare', 'yoneda-worker'])
    assert.ok(!new RegExp(`^${agent}\\b`, 'm').test(manifest), `yoneda-platform depends on ${agent}`);
  const store = await readFile('backend/crates/yoneda-store/Cargo.toml', 'utf8');
  assert.ok(!/^yoneda-(app|runtime|platform)\b/m.test(store), 'yoneda-store stays a leaf');
});

test('platform Rust modules use only platform code and core contracts', async () => {
  const root = 'backend/crates/yoneda-platform/src';
  const files = [
    ...(await readdir(`${root}/repo_store`)).map((f) => `${root}/repo_store/${f}`),
    ...(await readdir(root)).filter((f) => f.endsWith('.rs')).map((f) => `${root}/${f}`),
  ].filter((f) => f.endsWith('.rs'));
  for (const file of files) {
    const source = await readFile(file, 'utf8');
    for (const [, module] of source.matchAll(/yoneda_core::([a-z_]+)/g))
      assert.ok(
        ['git_object', 'txlog', 'textdiff', 'merge', 'search', 'blame', 'Error', 'Result', 'digest', 'fingerprint', 'validate_path'].includes(module),
        `${file} uses yoneda_core::${module}`,
      );
  }
});
