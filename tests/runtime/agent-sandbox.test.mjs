// Kit item 29's agent sandbox (tools/staging/agent-sandbox.mjs, agent-sandbox-host.mjs): the
// docker command mounts the clone and nothing else, the container's environment is the
// allowlist (no host variable, no gh or SSH agent), secrets never reach the command line, the
// agent is on the egress-limited network and its proxy forwards to the platform and the model
// provider's API by exact name only, only the model's provider credential is passed, and the
// host snapshots catch what an escaped agent did on 2026-10-28 (commits on main, a switched
// branch, a nested worktree, a push to the host's remote), and the proxy outlives a client
// that resets a refused tunnel.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { hostState } from '../../tools/staging/agent-sandbox-host.mjs';
import { clientEnv, credentialFor, EGRESS_PORT, egressAllowlist, egressArgs, HOOK_LOG, hostDrift, IMAGE, sandboxArgs, sandboxEnv, sandboxOrigin, WORKDIR } from '../../tools/staging/agent-sandbox.mjs';
import { allowed, parseAllow, serve, targetOf } from '../../tools/staging/agent-sandbox/egress-proxy.mjs';

const HOST = {
  PATH: '/opt/homebrew/bin:/usr/bin',
  HOME: '/Users/operator',
  PWD: '/Users/operator/yonedarepo',
  GH_TOKEN: 'gh-secret',
  SSH_AUTH_SOCK: '/private/tmp/agent.sock',
  OPENAI_API_KEY: 'sk-secret',
  GIT_CONFIG_GLOBAL: '/Users/operator/.gitconfig',
  XDG_CONFIG_HOME: '/Users/operator/.config',
  DOCKER_CONTEXT: 'desktop-linux',
};
const clone = '/private/var/folders/x/T/yoneda-kit-cli-abc/agent-w1a1';
const proxy = `172.18.0.2:${EGRESS_PORT}`;
const env = sandboxEnv({ origin: 'http://host.docker.internal:8787', token: 'repo-token-secret', remote: 'yoneda::http://host.docker.internal:8787/r1', credential: '[{"integrationID":"zai-coding-plan"}]', proxy });
const args = sandboxArgs({ name: 'yoneda-kit-w1a1', clone, env, command: ['opencode', 'run', '--standalone', 'task'], network: 'yoneda-sandbox-run1' });

test('the container mounts the clone at /work and no other host path', () => {
  assert.ok(!args.includes('-v') && !args.includes('--volume'), 'no -v mounts');
  const mounts = args.filter((_, i) => args[i - 1] === '--mount');
  assert.deepEqual(mounts, [`type=bind,source=${clone},target=${WORKDIR}`]);
  // Container-side paths aside (tmpfs targets, the image's files), no argument names a path.
  const hostPaths = args.filter((a, i) => args[i - 1] !== '--tmpfs' && /(^|[=,])\/(Users|private|var|home|opt|etc|tmp)\//.test(a) && !a.startsWith('/opt/yoneda'));
  assert.deepEqual(hostPaths, [`type=bind,source=${clone},target=${WORKDIR}`]);
  assert.equal(args[args.indexOf('--workdir') + 1], WORKDIR);
  assert.ok(HOOK_LOG.startsWith(`${WORKDIR}/.git/`), 'the hook log lives inside the clone');
  assert.throws(() => sandboxArgs({ name: 'x', clone: 'relative/dir', env, command: [], network: 'n' }));
  assert.throws(() => sandboxArgs({ name: 'x', clone: '/tmp/a,readonly=false', env, command: [], network: 'n' }));
});

test('the container is locked down: read-only root, no capabilities kept, no IPv6, the pinned image', () => {
  for (const flag of ['--rm', '--read-only', '--init']) assert.ok(args.includes(flag), flag);
  assert.equal(args[args.indexOf('--cap-drop') + 1], 'ALL');
  assert.deepEqual(args.filter((_, i) => args[i - 1] === '--cap-add').sort(), ['NET_ADMIN', 'SETGID', 'SETPCAP', 'SETUID']);
  assert.equal(args[args.indexOf('--security-opt') + 1], 'no-new-privileges');
  assert.equal(args[args.indexOf('--sysctl') + 1], 'net.ipv6.conf.all.disable_ipv6=1');
  assert.ok(!args.includes('--privileged') && !args.some((a) => a.startsWith('--net=')));
  assert.deepEqual(args.slice(args.indexOf(IMAGE)), [IMAGE, 'opencode', 'run', '--standalone', 'task']);
});

test("the container's environment is the allowlist, by name only", () => {
  assert.deepEqual(Object.keys(env).sort(), [
    'GIT_CONFIG_COUNT',
    'GIT_CONFIG_KEY_0',
    'GIT_CONFIG_KEY_1',
    'GIT_CONFIG_KEY_2',
    'GIT_CONFIG_NOSYSTEM',
    'GIT_CONFIG_VALUE_0',
    'GIT_CONFIG_VALUE_1',
    'GIT_CONFIG_VALUE_2',
    'GIT_TERMINAL_PROMPT',
    'HTTPS_PROXY',
    'HTTP_PROXY',
    'NO_PROXY',
    'OPENCODE_CONFIG_CONTENT',
    'SANDBOX_CREDENTIAL',
    'SANDBOX_EGRESS_PROXY',
    'SANDBOX_EXPECTED_ORIGIN',
    'YONEDA_AGENT_WORKDIR',
    'YONEDA_HOOK_LOG',
    'YONEDA_ORIGIN',
    'YONEDA_TOKEN',
    'http_proxy',
    'https_proxy',
    'no_proxy',
  ]);
  const named = args.filter((_, i) => args[i - 1] === '-e');
  assert.deepEqual(named, Object.keys(env).sort(), 'every -e names a variable, none carries a value');
  assert.ok(!args.join(' ').includes('repo-token-secret'), 'the token is not on the command line');
  assert.equal(env.SANDBOX_CREDENTIAL, 'stdin', 'the credential travels on stdin, not in the environment');
  assert.deepEqual(JSON.parse(env.OPENCODE_CONFIG_CONTENT), { plugins: [{ package: '/opt/yoneda/plugin' }] });
  const bare = sandboxEnv({ origin: 'https://api.example', token: 't', remote: 'yoneda::https://api.example/r1', credential: null, proxy });
  assert.ok(!('SANDBOX_CREDENTIAL' in bare));
});

test("the docker client gets the daemon's settings and the -e values, nothing else of the host", () => {
  const client = clientEnv(HOST, env);
  for (const leak of ['GH_TOKEN', 'SSH_AUTH_SOCK', 'OPENAI_API_KEY', 'PWD', 'GIT_CONFIG_GLOBAL', 'XDG_CONFIG_HOME']) assert.ok(!(leak in client), leak);
  assert.equal(client.DOCKER_CONTEXT, 'desktop-linux');
  assert.equal(client.YONEDA_TOKEN, 'repo-token-secret');
  // The container sees only the names passed with -e, so none of the client's own variables.
  const inside = new Set(args.filter((_, i) => args[i - 1] === '-e'));
  for (const name of ['PATH', 'HOME', 'DOCKER_CONTEXT']) assert.ok(!inside.has(name), name);
});

test('a loopback platform is reached through the host gateway; a hosted one directly', () => {
  assert.deepEqual(sandboxOrigin('http://127.0.0.1:8787'), { origin: 'http://host.docker.internal:8787' });
  assert.deepEqual(sandboxOrigin('http://localhost:9000/'), { origin: 'http://host.docker.internal:9000' });
  assert.deepEqual(sandboxOrigin('https://api-dev.yonedarepo.com'), { origin: 'https://api-dev.yonedarepo.com' });
});

test('the agent is on the internal network and every client goes through the egress proxy', () => {
  assert.equal(args[args.indexOf('--network') + 1], 'yoneda-sandbox-run1');
  assert.throws(() => sandboxArgs({ name: 'x', clone, env, command: [] }), /egress-limited network/);
  for (const name of ['HTTPS_PROXY', 'HTTP_PROXY', 'https_proxy', 'http_proxy']) assert.equal(env[name], `http://${proxy}`);
  assert.equal(env.SANDBOX_EGRESS_PROXY, proxy);
  // By address: no client depends on Docker's DNS to find its way out.
  for (const name of ['egress:3128', '172.18.0.2', 'http://172.18.0.2:3128', undefined])
    assert.throws(() => sandboxEnv({ origin: 'https://api.example', token: 't', remote: 'r', credential: null, proxy: name }), /IPv4 address:port/);
  // The proxy: no mount, no capabilities, its allowlist by name only; kept after it exits, so
  // its log (what it refused, why it died) outlives it (startEgress's stop removes it).
  const proxyArgs = egressArgs({ name: 'yoneda-egress-run1' });
  assert.ok(!proxyArgs.includes('--mount') && !proxyArgs.includes('-v') && !proxyArgs.includes('--network'));
  assert.ok(!proxyArgs.includes('--rm'));
  assert.equal(proxyArgs[proxyArgs.indexOf('--cap-drop') + 1], 'ALL');
  assert.deepEqual(proxyArgs.filter((_, i) => proxyArgs[i - 1] === '-e'), ['SANDBOX_EGRESS_ALLOW']);
  assert.deepEqual(proxyArgs.slice(proxyArgs.indexOf(IMAGE)), [IMAGE, '/opt/yoneda/egress-proxy.mjs']);
});

/** The proxy's status line for `CONNECT target` on `port`; `reset` drops the connection with a
 * TCP reset once it answers, as opencode's Bun runtime does with a refused tunnel. */
function connectVia(port, target, { reset = false } = {}) {
  return new Promise((resolve, reject) => {
    const socket = connect({ host: '127.0.0.1', port }, () => socket.write(`CONNECT ${target} HTTP/1.1\r\n\r\n`));
    socket.once('data', (chunk) => {
      if (reset) socket.resetAndDestroy();
      else socket.destroy();
      resolve(String(chunk).split('\r\n')[0]);
    });
    socket.on('error', reject);
  });
}

// Why: on 2026-10-28 the proxy died of the first reset (an unhandled ECONNRESET), and every
// agent after it failed with "getaddrinfo EAI_AGAIN egress".
test('the proxy outlives clients that reset refused tunnels', async () => {
  const server = serve(parseAllow('example.org:443'), 0, () => {});
  await once(server, 'listening');
  const { port } = server.address();
  try {
    for (let i = 0; i < 20; i++) assert.match(await connectVia(port, 'example.com:443', { reset: true }), /^HTTP\/1\.1 403 /);
    // A reset racing the proxy's answer, before it is read.
    for (let i = 0; i < 20; i++) {
      const socket = connect({ host: '127.0.0.1', port }, () => {
        socket.write('CONNECT example.com:443 HTTP/1.1\r\n\r\n');
        socket.resetAndDestroy();
      });
      socket.on('error', () => {});
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.match(await connectVia(port, 'example.com:443'), /^HTTP\/1\.1 403 /);
  } finally {
    server.close();
  }
});

test('egress is the platform and the model provider, by exact host:port', () => {
  assert.deepEqual(egressAllowlist({ origin: 'https://api-dev.yonedarepo.com', model: 'zai-coding-plan/glm-5.3' }), ['api-dev.yonedarepo.com:443', 'api.z.ai:443']);
  assert.deepEqual(egressAllowlist({ origin: 'http://host.docker.internal:8787', model: null }), ['host.docker.internal:8787']);
  assert.throws(() => egressAllowlist({ origin: 'https://api-dev.yonedarepo.com', model: 'unknown-provider/m' }), /no egress host is known/);
  const allow = parseAllow('api.z.ai:443, API-DEV.yonedarepo.com:443,host.docker.internal:8787');
  assert.ok(allowed('CONNECT', 'api.z.ai:443', allow));
  assert.ok(allowed('CONNECT', 'API.Z.AI:443', allow));
  assert.ok(allowed('GET', 'http://host.docker.internal:8787/api/v1/repos/r1', allow));
  for (const [method, url] of [
    ['CONNECT', 'api.z.ai:80'],
    ['CONNECT', 'evil.api.z.ai:443'],
    ['CONNECT', 'z.ai:443'],
    ['CONNECT', 'example.com:443'],
    ['CONNECT', '1.1.1.1:443'],
    ['GET', 'http://example.com/'],
    ['GET', 'https://api.z.ai/'],
    ['GET', '/relative'],
    ['CONNECT', 'api.z.ai:443@example.com:443'],
  ])
    assert.ok(!allowed(method, url, allow), `${method} ${url}`);
  assert.equal(targetOf('GET', 'http://host.docker.internal:8787/x'), 'host.docker.internal:8787');
  assert.equal(parseAllow('').size, 0, 'no allowlist forwards nothing');
  assert.throws(() => parseAllow('*.z.ai:443'), /not host:port/);
});

test("only the model's provider credential is passed", () => {
  const exported = [
    { integrationID: 'zai-coding-plan', value: { type: 'key', key: 'k1' } },
    { integrationID: 'openai', value: { type: 'key', key: 'k2' } },
  ];
  assert.deepEqual(JSON.parse(credentialFor(exported, 'zai-coding-plan/glm-5.3')), [exported[0]]);
  assert.equal(credentialFor(exported, 'anthropic/claude-sonnet-5-5'), null);
  assert.equal(credentialFor(null, 'zai-coding-plan/glm-5.3'), null);
});

const snapshot = (over = {}) => ({
  checkouts: { '/r': { head: 'a1', branch: 'refs/heads/dev', main: 'm1', status: ' M x', nested: '', ...over } },
  remotes: { 'https://github.com/o/r.git': 'm1\trefs/heads/main\nd1\trefs/heads/dev' },
});

test('host drift: nothing changed is no problem; each kind of change is named', () => {
  assert.deepEqual(hostDrift(snapshot(), snapshot()), []);
  assert.match(hostDrift(snapshot(), snapshot({ head: 'a2' })).join(), /\/r: head a1 → a2/);
  assert.match(hostDrift(snapshot(), snapshot({ branch: 'refs/heads/main' })).join(), /branch refs\/heads\/dev → refs\/heads\/main/);
  assert.match(hostDrift(snapshot(), snapshot({ main: 'm2' })).join(), /main m1 → m2/);
  assert.match(hostDrift(snapshot(), snapshot({ status: ' M x\n?? src/util.js' })).join(), /status: \+\?\? src\/util\.js/);
  assert.match(hostDrift(snapshot(), snapshot({ nested: '/r/.worktrees/w2a1' })).join(), /worktrees inside it: \+\/r\/\.worktrees\/w2a1/);
  const pushed = { ...snapshot(), remotes: { 'https://github.com/o/r.git': 'm9\trefs/heads/main\nd1\trefs/heads/dev' } };
  assert.match(hostDrift(snapshot(), pushed).join(), /remote https:\/\/github\.com\/o\/r\.git: refs: \+m9\trefs\/heads\/main, -m1\trefs\/heads\/main/);
  assert.match(hostDrift(snapshot(), { checkouts: {}, remotes: {} }).join(), /could not be read after the run.*could not be read after the run/);
});

test('host snapshots of real checkouts catch what the escaped agents did', async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'yoneda-sandbox-host-')));
  const git = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' } }).trim();
  try {
    const remote = join(dir, 'remote.git');
    const host = join(dir, 'host');
    git(dir, 'init', '-q', '--bare', '-b', 'main', remote);
    git(dir, 'init', '-q', '-b', 'main', host);
    for (const [k, v] of [['user.name', 'Op'], ['user.email', 'op@x.invalid']]) git(host, 'config', k, v);
    writeFileSync(join(host, 'README'), 'host\n');
    writeFileSync(join(host, '.gitignore'), '/.worktrees/\n');
    git(host, 'add', '-A');
    git(host, 'commit', '-q', '-m', 'init');
    git(host, 'remote', 'add', 'origin', remote);
    git(host, 'push', '-q', 'origin', 'main');
    git(host, 'switch', '-q', '-c', 'dev');
    const before = await hostState([host, join(host, '.'), undefined]);
    assert.deepEqual(Object.keys(before.checkouts), [host]);
    assert.deepEqual(hostDrift(before, await hostState([host])), []);

    // What the agents did in the operator's checkout on 2026-10-28.
    git(host, 'switch', '-q', 'main');
    writeFileSync(join(host, 'CHANGELOG.md'), '- w1a1: added clamp\n');
    git(host, 'add', 'CHANGELOG.md');
    git(host, 'commit', '-q', '-m', 'w1a1: add clamp');
    git(host, 'push', '-q', 'origin', 'main');
    git(host, 'worktree', 'add', '-q', '.worktrees/w2a1');
    git(host, 'switch', '-q', 'dev');
    const drift = hostDrift(before, await hostState([host])).join('\n');
    assert.match(drift, /main [0-9a-f]+ → [0-9a-f]+/);
    assert.match(drift, /worktrees inside it: \+.*\.worktrees\/w2a1/);
    assert.match(drift, /remote .*remote\.git: refs: .*\+[0-9a-f]+\trefs\/heads\/main/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
