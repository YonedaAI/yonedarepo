// Explicit offline sandbox check: stock OpenCode against a local simulated provider, no model.
// Build the agent sandbox first, then: node tests/agents/gateway-limits.mjs
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { hostProblems } from '../../tools/staging/agent-run-flow.mjs';
import { hostState } from '../../tools/staging/agent-sandbox-host.mjs';
import { IMAGE } from '../../tools/staging/agent-sandbox.mjs';

const root = dirname(execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { encoding: 'utf8' }).trim());
await mkdir(join(root, '.local/staging'), { recursive: true });
const clone = await mkdtemp(join(root, '.local/staging/opencode-limits-'));
await writeFile(join(clone, 'README.md'), '# Offline configuration fixture\n');
execFileSync('git', ['init', '-q', '--initial-branch=main', clone]);
const watched = [root, process.cwd(), process.env.PWD];
const before = await hostState(watched);

async function fixture() {
  const { createServer } = await import('node:http');
  const { once } = await import('node:events');
  const { spawn } = await import('node:child_process');
  const assert = (await import('node:assert/strict')).default;
  const seen = [];
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    seen.push(body);
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    for (const chunk of [
      { choices: [{ index: 0, delta: { role: 'assistant', content: 'ok' }, finish_reason: null }] },
      { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 } },
    ]) res.write(`data: ${JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', created: 1, model: 'test', ...chunk })}\n\n`);
    res.end('data: [DONE]\n\n');
  }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const config = { update: 'disable', share: 'disabled', default_agent: 'build', agents: { build: { steps: 1 } }, providers: {
      fixture: { package: '@opencode/ai/providers/openai-compatible', settings: { baseURL: `http://127.0.0.1:${server.address().port}/v1`, apiKey: 'fixture' }, models: { test: { type: 'chat', limit: { context: 32000, output: 8192 }, body: { max_tokens: 8192 } } } },
    } };
    const child = spawn('opencode', ['run', '--standalone', '--auto', '--format', 'json', '--model', 'fixture/test', 'Say ok.'], { cwd: '/work', env: { ...process.env, OPENCODE_CONFIG_CONTENT: JSON.stringify(config) }, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { output += chunk; });
    const timer = setTimeout(() => child.kill('SIGKILL'), 45_000);
    const [code] = await once(child, 'close');
    clearTimeout(timer);
    assert.equal(code, 0, output.slice(-2000));
    assert.equal(seen.length, 1, 'one final agent step');
    assert.equal(seen[0].max_tokens, 8192, 'provider output overlay reached the actual request');
    assert.ok(!seen[0].tools?.length, 'final configured step has no tools');
    console.log('PASS simulated OpenCode: configured step and output limits reached the API');
  } finally { server.closeAllConnections(); server.close(); }
}

try {
  const name = `yoneda-demo-limits-${Date.now().toString(36)}`;
  const child = spawn('docker', ['run', '--rm', '--name', name, '--network', 'none', '--read-only', '--user', '1000:1000', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--tmpfs', '/tmp:rw', '--mount', `type=bind,src=${resolve(clone)},dst=/work`, '--workdir', '/work', '--env', 'HOME=/tmp/fixture-home', '--env', 'GIT_CONFIG_COUNT=1', '--env', 'GIT_CONFIG_KEY_0=safe.directory', '--env', 'GIT_CONFIG_VALUE_0=/work', '--entrypoint', 'node', '-i', IMAGE, '--input-type=module'], { stdio: ['pipe', 'pipe', 'pipe'] });
  child.stdin.end(`await (${fixture.toString()})();`);
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });
  const code = await new Promise(done => child.on('close', done));
  assert.equal(code, 0, output.slice(-3000));
  process.stdout.write(output);
} finally {
  await rm(clone, { recursive: true, force: true });
  const drift = await hostProblems(before, watched);
  assert.deepEqual(drift, [], 'host checkouts and every remote must stay unchanged');
}
