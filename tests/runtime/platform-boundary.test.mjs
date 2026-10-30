// The source platform stands alone: platform modules import only each other and neutral
// infrastructure, and the front Worker reaches the platform only through its public API.
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
  // Container SDK errors proving no instance was allocated (capacity); imports nothing.
  './container-capacity',
  // HMAC-SHA256 helpers (session cookies, webhook signatures); imports nothing.
  './hmac',
  // The account authority's command call (accounts, personal tokens); imports only types.
  './workspace',
  // Picture URLs by handle and the account's avatar op; imports only shared, types, workspace.
  './avatars',
  // The readable repository addresses both Workers route; imports nothing.
  './readable-paths',
  // Who the operator accounts are (ADMIN_ACCOUNTS); imports only types.
  './admin-auth',
  // The operators' account index rows and last-seen day; imports background, types, workspace.
  './account-index',
  // The site analytics data point layout (blob positions) the traffic queries read; imports only types.
  './site-events',
  '../../shared/site-traffic',
  // Account identifier rules (yoneda-core::account's transport counterpart); imports nothing.
  '../../shared/account',
  // Contact support's limits and attachment types, shared with the browser; imports nothing.
  '../../shared/support',
  '../../backend/crates/yoneda-worker/build/worker/shim.mjs',
  '../../backend/crates/yoneda-core/src/platform_tools.json',
]);

test('platform adapter modules import only platform and neutral modules', async () => {
  const files = (await readdir(worker)).filter((f) => /^(repo-.*|check-container|platform-.*|account-mcp)\.ts$/.test(f));
  assert.ok(files.length >= 10, files.join());
  for (const file of files) {
    const source = await readFile(`${worker}/${file}`, 'utf8');
    for (const [, target] of source.matchAll(/from '(\.[^']+)'/g)) {
      const allowed = neutral.has(target) || /^\.\/((repo|platform)-[a-z0-9-]+|account-mcp)$/.test(target);
      assert.ok(allowed, `${file} imports ${target}`);
    }
  }
});

// Crate-to-crate dependencies are checked by `cargo xtask layers` against xtask/layers.toml.
const crates = 'backend/crates';

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
  // `PLATFORM_MCP_TOOLS`: the MCP tool schemas (a core contract) the platform's tests pin
  // against its own event and role lists. `transcript`: the session transcript shape and
  // truncation rule, which the CLI fits uploads to as well.
  const allowed = ['git_object', 'transport', 'txlog', 'textdiff', 'merge', 'search', 'blame', 'account', 'transcript', 'Error', 'Result', 'digest', 'fingerprint', 'validate_path', 'validate_symlink', 'hex', 'PLATFORM_MCP_TOOLS'];
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

test('the front Worker reaches the platform only through its public API', async () => {
  const seen = new Set();
  const pending = ['front-index'];
  while (pending.length) {
    const module = pending.pop();
    if (seen.has(module)) continue;
    seen.add(module);
    const source = await readFile(`${worker}/${module}.ts`, 'utf8');
    for (const [, target] of source.matchAll(/from '\.\/([^']+)'/g)) pending.push(target);
  }
  assert.ok(seen.has('front-routes') && seen.has('front-entrypoint'), [...seen].join());
  for (const module of seen)
    assert.ok(!/^(repo-|platform-|check-container$|entrypoint$)/.test(module), `front Worker imports ${module}`);
  const config = await readFile('cloudflare/wrangler.dev-agents.jsonc', 'utf8');
  for (const binding of ['SOURCE_REPOS', 'CHECK_RUNNERS', 'OBJECT_PUSHES', 'PLATFORM_QUEUE', 'PLATFORM_IMPORT'])
    assert.ok(!config.includes(`"${binding}"`), `front Worker binds ${binding}`);
  assert.match(config, /"binding": "PLATFORM",\s*"service": "yonedarepo-dev-platform"/);
});
