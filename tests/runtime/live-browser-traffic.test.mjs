// Our tools mark their requests, so analytics leave them out: every browser context, API session,
// Git process, CLI run and bench the kit starts carries the mark, and the mark is the one the
// Workers read. A tool that talks to the platform without it fails here.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { client as acceptanceClient } from '../../tools/acceptance/client.mjs';
import { headers as benchHeaders } from '../../tools/fanout-bench/requests.js';
import { gitConfigEnv, OWN_TRAFFIC_ENV } from '../../tools/own-traffic.mjs';
import { sandboxEnv } from '../../tools/staging/agent-sandbox.mjs';
import { serve as gatewayShim } from '../../tools/staging/agent-sandbox/gateway-shim.mjs';
import { OWN_TRAFFIC, Session } from '../../tools/staging/client.mjs';
import { CliKit } from '../../tools/staging/cli-tools.mjs';
import { Walk } from '../../tools/staging/cli-walk-kit.mjs';
import { McpClient } from '../../tools/staging/mcp-client.mjs';
import { Workspace } from '../../tools/staging/realuser-git.mjs';

const [NAME, VALUE] = Object.entries(OWN_TRAFFIC)[0];
const LINE = `${NAME}: ${VALUE}`;
const HELPER = 'tools/own-traffic.mjs';

/** A fetch that never reaches the platform or the mark, by file, and why. */
const NOT_THE_PLATFORM = new Map([
  ['tools/check-setup-bench.mjs', 'a check server on this machine'],
  ['tools/platform-analytics.mjs', 'Cloudflare and Basin APIs'],
  ['tools/platform-basin-soak.mjs', 'Cloudflare and Basin APIs'],
  ['tools/ship/find-ship.mjs', 'GitHub'],
  ['tools/ship/monitor.mjs', 'Superfan and /health, which is not a client request'],
  ['tools/staging/webhook-flow.mjs', "the bench Worker's hook box"],
  ['tools/fanout-bench/worker.js', 'the bench Worker calling itself'],
  ['tools/staging/agent-sandbox/gateway-shim.mjs', 'model provider forwarding, verified below'],
]);
/** A fetch whose headers come from somewhere a test below checks. */
const CHECKED_ELSEWHERE = new Map([
  ['tools/staging/client.mjs', 'Session.headers'],
  ['tools/staging/mcp-client.mjs', 'McpClient.headers'],
  ['tools/fanout-bench/requests.js', 'headers'],
  ['tools/fanout-bench/region-steps.js', 'the init runStep builds, tested in region-tools.test.mjs'],
  ['tools/staging/cli-tools.mjs', "the proxy forwards the CLI's own headers"],
  ['tools/staging/agent-sandbox/codex-run.mjs', 'the actual API helper headers, verified below'],
]);
/** Stock Git over SSH: the protocol has no header to carry, so these runs stay counted. */
const OVER_SSH = new Set(['tools/staging/ssh-flow.mjs']);
/** Git commands in these files reach no platform: local repositories only, or just their names. */
const LOCAL_GIT = new Set([
  'tools/gen-site-reference.mjs',
  'tools/source-benchmark/git.mjs',
  'tools/source-benchmark/fixture.mjs',
  'tools/source-benchmark/baseline.mjs',
]);

async function toolFiles(dir = 'tools') {
  const entries = await readdir(dir, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map((e) => {
      const path = `${dir}/${e.name}`;
      if (e.isDirectory()) return e.name === 'node_modules' || e.name === '__pycache__' ? [] : toolFiles(path);
      return /\.(mjs|js)$/.test(e.name) && !e.name.endsWith('.test.mjs') ? [path] : [];
    }),
  );
  return nested.flat();
}

/** The text of each `fetch(...)` call in `source`: a method named fetch is not one. */
function fetchCalls(source) {
  const calls = [];
  for (const { index } of source.matchAll(/(?<![.\w])fetch\(/g)) {
    if (/async\s+$/.test(source.slice(Math.max(0, index - 8), index))) continue;
    let depth = 0;
    for (let at = index + 5; at < source.length; at++) {
      if (source[at] === '(') depth += 1;
      if (source[at] === ')' && --depth === 0) {
        calls.push(source.slice(index, at + 1));
        break;
      }
    }
  }
  return calls;
}

test('every live browser context sends the mark the front Worker looks for', async () => {
  const worker = await readFile('cloudflare/worker/site-events.ts', 'utf8');
  assert.match(worker, new RegExp(`OWN_TRAFFIC_HEADER = '${NAME}'`));
  assert.equal(VALUE, '1');
  let contexts = 0;
  for (const file of await toolFiles()) {
    const source = await readFile(file, 'utf8');
    for (const [call] of source.matchAll(/\.newContext\([^)]*\)/g)) {
      contexts += 1;
      assert.match(call, /extraHTTPHeaders: OWN_TRAFFIC/, `${file}: ${call}`);
    }
  }
  assert.ok(contexts > 0, 'no browser context found: the pattern above went stale');
});

test('every kit API session sends the mark too', () => {
  const headers = new Session('https://x.test', { bearer: 'token' }).headers();
  assert.equal(headers[NAME], VALUE);
});

test('the sandbox Codex API helper marks reads and writes without running an agent', async () => {
  const source = await readFile('tools/staging/agent-sandbox/codex-run.mjs', 'utf8');
  assert.equal(fetchCalls(source).length, 1, 'a new fetch needs its own traffic check');
  // Evaluate the real declarations only, before context delivery or CLI startup. Neither
  // credentials nor subprocess capabilities from the host enter this fixture.
  const begin = source.indexOf('const headers =');
  const end = source.indexOf('\nconst packet =', begin);
  assert.ok(begin >= 0 && end > begin, 'the API declaration boundary changed');
  const sent = [];
  const api = runInNewContext(`${source.slice(begin, end)}\napi;`, {
    origin: 'https://platform.test', repo: 'fixture',
    process: { env: { YONEDA_TOKEN: 'fixture-token' } },
    fetch: async (url, init) => {
      sent.push({ url, ...init });
      return new Response('{}', { status: 200 });
    },
  });
  await api('/context?memories=8');
  await api('/context/deliveries', { method: 'POST', body: '{}' });
  assert.equal(sent.length, 2);
  assert.equal(sent[0].url, 'https://platform.test/api/v1/repos/fixture/context?memories=8');
  assert.equal(sent[1].url, 'https://platform.test/api/v1/repos/fixture/context/deliveries');
  assert.equal(sent[1].method, 'POST');
  assert.equal(sent[1].body, '{}');
  for (const { headers } of sent) {
    assert.equal(headers[NAME], VALUE);
    assert.equal(headers.authorization, 'Bearer fixture-token');
  }
});

test('the sandbox gateway fetch is model traffic and cannot forward a website or API path', async () => {
  const source = await readFile('tools/staging/agent-sandbox/gateway-shim.mjs', 'utf8');
  assert.equal(fetchCalls(source).length, 1, 'a new fetch needs its own traffic check');
  const seen = [];
  const upstream = createServer((req, res) => {
    seen.push(req.url);
    res.writeHead(200, { 'content-type': 'application/json' }).end('{}');
  });
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  const shim = gatewayShim({ gateway: `http://127.0.0.1:${upstream.address().port}/provider`, token: 'fixture', model: 'fixture-model', port: 0 });
  await once(shim, 'listening');
  const origin = `http://127.0.0.1:${shim.address().port}`;
  const ask = (path) => fetch(`${origin}${path}`, { method: 'POST', body: JSON.stringify({ model: 'fixture-model', input: 'fixture' }) });
  try {
    for (const path of ['/', '/api/v1/repos', '/api/v1/mcp'])
      assert.equal((await ask(path)).status, 403);
    assert.deepEqual(seen, [], 'platform paths must never reach the provider fetch');
    assert.equal((await ask('/openai/responses')).status, 200);
    assert.deepEqual(seen, ['/provider/openai/responses']);
  } finally {
    await Promise.all([new Promise((done) => shim.close(done)), new Promise((done) => upstream.close(done))]);
  }
});

test('every fetch in a tool carries the mark, or goes somewhere that never counts', async () => {
  const unmarked = [];
  let calls = 0;
  for (const file of await toolFiles()) {
    if (NOT_THE_PLATFORM.has(file) || CHECKED_ELSEWHERE.has(file)) continue;
    for (const call of fetchCalls(await readFile(file, 'utf8'))) {
      calls += 1;
      // x-bench-key goes to our bench Worker, whose requests are `benchHeaders` below.
      if (!/OWN_TRAFFIC|x-bench-key/.test(call)) unmarked.push(`${file}: ${call.slice(0, 80)}`);
    }
  }
  assert.ok(calls > 10, 'no fetch found: the pattern above went stale');
  assert.deepEqual(unmarked, []);
});

test('every xtask command that calls the platform API uses the marked client', async () => {
  const admin = await readFile('xtask/src/admin.rs', 'utf8');
  assert.ok(admin.includes(`"${NAME}"`), 'the marked client sends this header');
  const files = (await readdir('xtask/src', { recursive: true })).filter((f) => f.endsWith('.rs'));
  const callers = [];
  for (const file of files) {
    const source = await readFile(`xtask/src/${file}`, 'utf8');
    if (!/\/api\/v1\//.test(source.replace(/^\s*\/\/.*$/gm, ''))) continue;
    callers.push(file);
    assert.match(source, /platform_client\(/, file);
  }
  assert.ok(callers.length >= 4, 'no platform call found: the pattern above went stale');
});

test('Git gets its configuration from the one helper, so nothing skips the mark', async () => {
  for (const file of await toolFiles()) {
    if (file === HELPER) continue;
    assert.doesNotMatch(await readFile(file, 'utf8'), /GIT_CONFIG_KEY_/, file);
  }
});

test('every tool that runs Git against a remote takes its environment from the helper', async () => {
  const unmarked = [];
  for (const file of await toolFiles()) {
    if (OVER_SSH.has(file) || LOCAL_GIT.has(file) || file === HELPER) continue;
    // Item 48's people: `Person.env`, checked below, is the only environment they run with.
    if (file.startsWith('tools/staging/cli-walk-')) continue;
    const source = await readFile(file, 'utf8');
    const talks = /\[\s*(?:'-c', [^\]]*?)?'(?:clone|fetch|push|pull|ls-remote)'|git\([^)]*'(?:clone|fetch|push|pull|ls-remote)'/.test(source);
    // `gitSession` (tools/fanout-bench/mac-git.mjs) takes its environment from the helper too.
    if (talks && !/gitConfigEnv|gitSession\(|\b(?:kit|ws)\.(?:ok|run|git|env)\(/.test(source)) unmarked.push(file);
  }
  assert.deepEqual(unmarked, []);
});

test('the helper puts the mark on Git once, beside the token, on the same key', () => {
  const open = gitConfigEnv();
  assert.equal(open.GIT_CONFIG_COUNT, '1');
  assert.equal(open.GIT_CONFIG_VALUE_0, LINE);
  const scoped = gitConfigEnv({ token: 't', origin: 'https://api.test', headers: ['x-a: 1'], config: [['core.x', 'y']] });
  assert.equal(scoped.GIT_CONFIG_COUNT, '4');
  assert.equal(scoped.GIT_CONFIG_KEY_0, 'core.x');
  for (const i of [1, 2, 3]) assert.equal(scoped[`GIT_CONFIG_KEY_${i}`], 'http.https://api.test/.extraHeader');
  assert.equal(scoped.GIT_CONFIG_VALUE_1, 'Authorization: Bearer t');
  assert.equal(scoped.GIT_CONFIG_VALUE_3, LINE);
});

test('real Git sends the mark exactly once, with its token, on each kind of key', async () => {
  const seen = [];
  const server = createServer((req, res) => {
    seen.push(req.headers);
    res.writeHead(404).end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const home = mkdtempSync(join(tmpdir(), 'own-traffic-'));
  const lsRemote = (config) =>
    new Promise((resolve) => {
      const git = spawn('git', ['ls-remote', `${origin}/git/r.git`], {
        env: { PATH: process.env.PATH, HOME: home, GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0', ...config },
        stdio: 'ignore',
      });
      git.on('close', resolve);
    });
  try {
    for (const config of [gitConfigEnv({ token: 't', origin }), gitConfigEnv({ token: 't' }), gitConfigEnv()]) {
      seen.length = 0;
      await lsRemote(config);
      assert.ok(seen.length > 0, 'Git reached the server');
      assert.equal(seen[0][NAME], VALUE, 'one header, not a joined `1, 1`');
      if (config.GIT_CONFIG_VALUE_1) assert.equal(seen[0].authorization, 'Bearer t');
    }
  } finally {
    server.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test('the bench client, MCP client and acceptance client send the mark', async () => {
  assert.equal(benchHeaders({ token: 't' })[NAME], VALUE);
  assert.equal(benchHeaders({ cookie: 'c' })[NAME], VALUE);
  const sent = [];
  const real = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    sent.push(init.headers);
    return new Response(JSON.stringify({ result: { content: [{ text: '{}' }] } }), { status: 200 });
  };
  try {
    const mcp = new McpClient('https://x.test/mcp', 't');
    await mcp.rpc('initialize', {});
    await mcp.attempt('tool', {});
    const acceptance = acceptanceClient('https://x.test');
    await acceptance.api('repos');
    await acceptance.mcp('r', 't', 'tool', {});
  } finally {
    globalThis.fetch = real;
  }
  assert.equal(sent.length, 4);
  for (const headers of sent) assert.equal(headers[NAME], VALUE);
});

test('every process the kit starts tells the CLI and Git to mark what they send', () => {
  const kit = new CliKit({ api: 'https://x.test', bin: '/bin' });
  const env = kit.env();
  rmSync(kit.dir, { recursive: true, force: true });
  assert.equal(env.YONEDA_OWN_TRAFFIC, OWN_TRAFFIC_ENV.YONEDA_OWN_TRAFFIC);
  assert.equal(env.GIT_CONFIG_VALUE_0, LINE);
  const user = new Workspace({ api: 'https://x.test', bin: '/bin' });
  const seen = user.env('t');
  rmSync(user.dir, { recursive: true, force: true });
  assert.equal(seen.YONEDA_OWN_TRAFFIC, '1');
  assert.ok(Object.values(seen).includes(LINE));
  const walk = new Walk({ api: 'https://x.test', origin: 'https://x.test', bin: '/bin' });
  const person = walk.person('someone').env();
  walk.dispose();
  assert.equal(person.YONEDA_OWN_TRAFFIC, '1');
  assert.ok(Object.values(person).includes(LINE));
});

test('agents in the sandbox are marked by configuration, in both arms', () => {
  const given = { origin: 'https://api.test', token: 't', remote: 'x', credential: null, proxy: '172.18.0.2:3128' };
  const plugin = sandboxEnv(given);
  assert.equal(plugin.YONEDA_OWN_TRAFFIC, '1');
  const plain = sandboxEnv({ ...given, plain: true });
  for (const env of [plugin, plain]) assert.ok(Object.values(env).includes(LINE));
});
