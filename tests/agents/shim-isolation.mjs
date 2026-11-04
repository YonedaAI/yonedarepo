// Explicit offline Linux boundary test. No model or platform request is made.
// Build the agent image, then: node tests/agents/shim-isolation.mjs
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { hostProblems } from '../../tools/staging/agent-run-flow.mjs';
import { hostState, startEgress } from '../../tools/staging/agent-sandbox-host.mjs';
import { clientEnv, IMAGE, sandboxArgs, sandboxEnv } from '../../tools/staging/agent-sandbox.mjs';
import { removeOwnedContainer } from '../../tools/staging/demo-repos-acceptance.mjs';

const root = dirname(execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { encoding: 'utf8' }).trim());
await mkdir(join(root, '.local/staging'), { recursive: true });
const clone = await mkdtemp(join(root, '.local/staging/shim-isolation-'));
await writeFile(join(clone, 'README.md'), '# Simulated shim isolation fixture\n');
execFileSync('git', ['init', '-q', '--initial-branch=main', clone]);
const origin = 'https://dev.yonedarepo.com';
const remote = `yoneda::${origin}/r00000000000000000001`;
execFileSync('git', ['-C', clone, 'remote', 'add', 'origin', remote]);
const watched = [root, process.cwd(), process.env.PWD];
const before = await hostState(watched);
const name = `yoneda-demo-isolation-${Date.now().toString(36)}`;
let egress;

function probe() {
  const fs = require('node:fs');
  const assert = require('node:assert/strict');
  const pid = fs.readdirSync('/proc').filter(s => /^\d+$/.test(s)).find(pid => {
    try { return fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').includes('/opt/yoneda/gateway-shim.mjs'); }
    catch { return false; }
  });
  assert.ok(pid, 'the real sandbox shim is running');
  const status = fs.readFileSync(`/proc/${pid}/status`, 'utf8');
  const uid = Number(/^Uid:\s+(\d+)/m.exec(status)?.[1]);
  assert.notEqual(uid, process.getuid(), 'the agent must not own the credential holder');
  assert.throws(() => fs.readFileSync(`/proc/${pid}/environ`), { code: 'EACCES' }, 'the shim\'s original credential environment must be unreadable');
  assert.throws(() => process.kill(Number(pid), 0), { code: 'EPERM' }, 'the agent must not be able to signal the shim');
  assert.ok(!fs.readFileSync('/proc/self/environ', 'utf8').includes('SANDBOX_GATEWAY_TOKEN='), 'the agent\'s original environment never received the provider key');
  assert.equal(process.env.SANDBOX_GATEWAY_TOKEN, undefined);
  console.log('PASS simulated sandbox: separate UID, unreadable credential environment, no signal permission, clean agent environment');
}

try {
  egress = await startEgress({ image: IMAGE, allow: ['dev.yonedarepo.com:443'], run: `isolation${Date.now().toString(36)}` });
  const env = { ...sandboxEnv({ origin, token: 'fixture-repo-token', remote, proxy: egress.address }), SANDBOX_GATEWAY_URL: 'http://127.0.0.1:8877', SANDBOX_GATEWAY_TOKEN: 'fixture-only', SANDBOX_GATEWAY_MODEL: 'fixture' };
  const args = sandboxArgs({ name, clone: resolve(clone), env, command: ['node', '-e', `(${probe.toString()})();`], network: egress.network });
  const child = spawn('docker', args, { env: clientEnv(process.env, env), stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });
  const timer = setTimeout(() => { execFileSync('docker', ['rm', '-f', name], { stdio: 'ignore' }); }, 30_000);
  const code = await new Promise(done => child.on('close', done));
  clearTimeout(timer);
  assert.equal(code, 0, output.slice(-3000));
  process.stdout.write(output);
} finally {
  try { removeOwnedContainer(name); }
  finally {
    await egress?.stop();
    await rm(clone, { recursive: true, force: true });
    assert.deepEqual(await hostProblems(before, watched), [], 'host checkouts and every remote must stay unchanged');
  }
}
