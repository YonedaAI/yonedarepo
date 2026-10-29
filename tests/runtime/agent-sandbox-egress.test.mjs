// The agent sandbox's egress in real containers (opt-in: YONEDA_SANDBOX_IMAGE names a built
// sandbox image, e.g. `docker build -f tools/staging/agent-sandbox/Dockerfile -t
// yoneda-agent-sandbox:egress-test .`). An agent on the internal network reaches an
// allowlisted host only through the proxy and nothing directly; the proxy refuses and logs
// every other target and outlives clients that reset refused tunnels; and an agent does not
// start when its proxy would forward a host the egress check probes, or when its clients'
// proxy variables name another proxy (fail closed). No agent or model runs: the command is a
// Node probe.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { startEgress } from '../../tools/staging/agent-sandbox-host.mjs';
import { clientEnv, GUARD_EXIT, sandboxArgs, sandboxEnv } from '../../tools/staging/agent-sandbox.mjs';

const image = process.env.YONEDA_SANDBOX_IMAGE;
const skip = image ? false : 'set YONEDA_SANDBOX_IMAGE to a built sandbox image';
const origin = 'http://host.docker.internal:1';
const remote = `yoneda::${origin}/r1`;

/** What the probe reports from inside the agent container. */
const PROBE = `
const net = require('node:net');
const [host, port] = process.env.SANDBOX_EGRESS_PROXY.split(':');
const via = (target) => new Promise((done) => {
  const s = net.connect({ host, port: +port, timeout: 5000 }, () => s.write('CONNECT ' + target + ' HTTP/1.1\\r\\n\\r\\n'));
  s.on('data', (d) => { done(String(d).split('\\r\\n')[0]); s.destroy(); });
  s.on('error', () => done('error')); s.on('timeout', () => { done('timeout'); s.destroy(); });
});
const direct = (target) => new Promise((done) => {
  const [h, p] = target.split(':');
  const s = net.connect({ host: h, port: +p, timeout: 3000 }, () => { done('open'); s.destroy(); });
  s.on('error', () => done('refused')); s.on('timeout', () => { done('refused'); s.destroy(); });
});
(async () => console.log(JSON.stringify({
  allowed: await via('example.org:443'),
  other: await via('example.net:443'),
  direct: await direct('example.org:443'),
})))();
`;

function agent(egress, command, override = {}) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'yoneda-egress-')));
  try {
    const git = (...a) => execFileSync('git', a, { cwd: dir, env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' } });
    git('init', '-q');
    git('remote', 'add', 'origin', remote);
    const env = { ...sandboxEnv({ origin, token: 'not-a-token', remote, credential: null, proxy: egress.address }), ...override };
    const args = sandboxArgs({ name: `yoneda-egress-test-${Date.now().toString(36)}`, clone: dir, env, command, network: egress.network, image });
    return spawnSync('docker', args, { env: clientEnv(process.env, env), encoding: 'utf8', input: '', timeout: 120_000 });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('an agent reaches an allowlisted host through the proxy only, and the proxy logs the rest', { skip }, async () => {
  const egress = await startEgress({ image, allow: ['example.org:443'], run: `t${Date.now().toString(36)}` });
  let refused = [];
  try {
    const run = agent(egress, ['node', '-e', PROBE]);
    assert.equal(run.status, 0, run.stderr);
    const seen = JSON.parse(run.stdout.trim().split('\n').pop());
    assert.match(seen.allowed, /^HTTP\/1\.1 200 /);
    assert.match(seen.other, /^HTTP\/1\.1 403 /);
    assert.equal(seen.direct, 'refused');
  } finally {
    ({ refused } = await egress.stop());
  }
  // The egress check's probes and the agent's own attempt, each refused and named.
  for (const target of ['CONNECT example.com:443', 'CONNECT 1.1.1.1:443', 'CONNECT example.net:443']) assert.ok(refused.includes(target), `${target} in ${refused}`);
});

/** A client that drops a refused tunnel with a reset (as opencode's Bun runtime does), then an
 * agent-like fetch through $HTTPS_PROXY to an allowlisted host. */
const RESET_THEN_FETCH = `
const net = require('node:net');
const proxy = new URL(process.env.HTTPS_PROXY);
const reset = () => new Promise((done) => {
  const s = net.connect({ host: proxy.hostname, port: +proxy.port }, () => s.write('CONNECT example.net:443 HTTP/1.1\\r\\n\\r\\n'));
  s.on('data', () => { s.resetAndDestroy(); setTimeout(done, 500); });
  s.on('error', () => done());
});
(async () => {
  await reset();
  const seen = await fetch('https://example.org/').then((r) => String(r.status), (e) => String(e.cause?.code ?? e.cause?.message ?? e.message));
  console.log(JSON.stringify({ seen }));
})();
`;

// Why: on 2026-10-28 every real agent failed with "getaddrinfo EAI_AGAIN egress": opencode
// reset a refused tunnel, the proxy died of the unhandled ECONNRESET, Docker removed it
// (--rm) and with it the `egress` name and the log of what it refused.
test('a client resetting a refused tunnel does not take the proxy down', { skip }, async () => {
  const egress = await startEgress({ image, allow: ['example.org:443'], run: `r${Date.now().toString(36)}` });
  let stopped = null;
  try {
    const run = agent(egress, ['env', 'NODE_USE_ENV_PROXY=1', 'node', '-e', RESET_THEN_FETCH]);
    assert.equal(run.status, 0, run.stderr);
    assert.deepEqual(JSON.parse(run.stdout.trim().split('\n').pop()), { seen: '200' });
  } finally {
    stopped = await egress.stop();
  }
  assert.equal(stopped.died, null);
  assert.ok(stopped.refused.includes('CONNECT example.net:443'), `${stopped.refused}`);
});

test('no agent starts when its clients would use a proxy other than the one the egress check probes', { skip }, async () => {
  const egress = await startEgress({ image, allow: ['example.org:443'], run: `p${Date.now().toString(36)}` });
  try {
    const run = agent(egress, ['node', '-e', 'console.log("agent ran")'], { HTTPS_PROXY: 'http://egress:3128' });
    assert.equal(run.status, GUARD_EXIT, run.stderr);
    assert.match(run.stderr, /HTTPS_PROXY is http:\/\/egress:3128, not http:\/\/\d+\.\d+\.\d+\.\d+:3128/);
    assert.doesNotMatch(run.stdout, /agent ran/);
  } finally {
    await egress.stop();
  }
});

test('no agent starts when its proxy forwards a host the egress check probes', { skip }, async () => {
  const egress = await startEgress({ image, allow: ['example.com:443'], run: `w${Date.now().toString(36)}` });
  try {
    const run = agent(egress, ['node', '-e', 'console.log("agent ran")']);
    assert.equal(run.status, GUARD_EXIT, run.stderr);
    assert.match(run.stderr, /proxy answered "HTTP\/1\.1 200 Connection Established" for example\.com:443/);
    assert.doesNotMatch(run.stdout, /agent ran/);
  } finally {
    await egress.stop();
  }
});
