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
  // waitUntil plumbing (AsyncLocalStorage), no agent-layer knowledge.
  './background',
  // Durable Object call with one retry on a reset instance; imports nothing.
  './durable',
  // HMAC-SHA256 helpers (session cookies, webhook signatures); imports nothing.
  './hmac',
  // The account authority's command call (accounts, personal tokens); imports only types.
  './workspace',
  // Account identifier rules (yoneda-core::account's transport counterpart); imports nothing.
  '../../shared/account',
  '../../backend/crates/yoneda-worker/build/worker/shim.mjs',
  '../../backend/crates/yoneda-core/src/platform_tools.json',
]);

test('platform adapter modules import only platform and neutral modules', async () => {
  const files = (await readdir(worker)).filter((f) => /^(repo-.*|check-container|platform-.*|account-mcp)\.ts$/.test(f));
  assert.ok(files.length >= 10, files.join());
  for (const file of files) {
    const source = await readFile(`${worker}/${file}`, 'utf8');
    for (const [, target] of source.matchAll(/from '(\.[^']+)'/g)) {
      const allowed = neutral.has(target) || /^\.\/((repo|platform)-[a-z-]+|account-mcp)$/.test(target);
      assert.ok(allowed, `${file} imports ${target}`);
    }
  }
});

const crates = 'backend/crates';
const dependencies = async (crate) => {
  const manifest = await readFile(`${crates}/${crate}/Cargo.toml`, 'utf8');
  // Normal dependencies only; dev-dependencies may pull in native test stores.
  const section = manifest.split(/^\[dev-dependencies\]/m)[0];
  return [...section.matchAll(/^(yoneda-[a-z-]+)\s*[=.]/gm)].map(([, name]) => name);
};

test('the platform depends on core contracts and the store only; core and the store are leaves', async () => {
  assert.deepEqual((await dependencies('yoneda-platform')).sort(), ['yoneda-core', 'yoneda-store']);
  assert.deepEqual(await dependencies('yoneda-store'), ['yoneda-core']);
  assert.deepEqual(await dependencies('yoneda-core'), []);
  // Agent contracts live outside core, so nothing the platform can see knows about agents.
  assert.deepEqual(await dependencies('yoneda-agents-core'), ['yoneda-core']);
});

/** First path segment of each top-level item in the braced import starting at `start`. */
function topLevel(source, start) {
  const items = [];
  let depth = 0;
  let item = '';
  for (const char of source.slice(start)) {
    if (char === '{') depth++;
    if (char === '}' && depth-- === 0) break;
    if (char === ',' && depth === 0) {
      items.push(item);
      item = '';
    } else item += char;
  }
  return [...items, item].map((entry) => entry.trim().split(/::|\s/)[0]).filter(Boolean);
}

test('platform Rust modules use only platform code and core contracts', async () => {
  // `account`: members are named by account identifier, the same contract signup validates.
  const allowed = ['git_object', 'txlog', 'textdiff', 'merge', 'search', 'blame', 'account', 'Error', 'Result', 'digest', 'fingerprint', 'validate_path', 'hex'];
  const root = `${crates}/yoneda-platform/src`;
  const files = (await readdir(root, { recursive: true })).filter((f) => f.endsWith('.rs'));
  assert.ok(files.length >= 20, files.join());
  for (const file of files) {
    const source = await readFile(`${root}/${file}`, 'utf8');
    assert.ok(!/yoneda_(agents_core|app|runtime|cloudflare|worker)\b/.test(source), `${file} names an agent crate`);
    const used = [
      ...[...source.matchAll(/yoneda_core::([A-Za-z_]+)/g)].map(([, item]) => item),
      ...[...source.matchAll(/yoneda_core::\{/g)].flatMap((match) => topLevel(source, match.index + match[0].length)),
    ];
    for (const item of used) assert.ok(allowed.includes(item), `${file} uses yoneda_core::${item}`);
  }
});

test('the agent-layer Worker reaches the platform only through its public API', async () => {
  const seen = new Set();
  const pending = ['agents-index'];
  while (pending.length) {
    const module = pending.pop();
    if (seen.has(module)) continue;
    seen.add(module);
    const source = await readFile(`${worker}/${module}.ts`, 'utf8');
    for (const [, target] of source.matchAll(/from '\.\/([^']+)'/g)) pending.push(target);
  }
  assert.ok(seen.has('routes') && seen.has('agents-entrypoint'), [...seen].join());
  for (const module of seen)
    assert.ok(!/^(repo-|platform-|check-container$|entrypoint$)/.test(module), `agent Worker imports ${module}`);
  const config = await readFile('cloudflare/wrangler.agents.jsonc', 'utf8');
  for (const binding of ['SOURCE_REPOS', 'CHECK_RUNNERS', 'OBJECT_PUSHES', 'PLATFORM_QUEUE', 'PLATFORM_IMPORT'])
    assert.ok(!config.includes(`"${binding}"`), `agent Worker binds ${binding}`);
  assert.match(config, /"binding": "PLATFORM",\s*"service": "yonedarepo-platform-dev"/);
});
