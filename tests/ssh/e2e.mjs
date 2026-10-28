// Git over SSH end to end, locally: `wrangler dev` serves the platform Worker
// (tests/ssh/wrangler.jsonc), the gateway runs natively (or, with --docker, from the
// cloudflare/ssh-gateway image built for this machine's platform, removed afterwards) pointed
// at it, and stock git + OpenSSH run the kit's SSH flow (tools/staging/ssh-flow.mjs) against
// two fresh accounts. No network beyond localhost.
//
// By default the platform runs the tunnel front door (SSH_FRONT_DOOR=tunnel, SSH_HOST
// ssh.e2e.invalid), so every command goes through the ssh_config the platform hands out, with
// its cloudflared ProxyCommand replaced by `nc` to the gateway (a live tunnel needs its token);
// --direct connects to the gateway's port instead. The native gateway also starts a stand-in
// cloudflared (TUNNEL_TOKEN set), which records how it was started.
// Usage: node tests/ssh/e2e.mjs [--direct] [--docker]
import { execFileSync, spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Session, sleep } from '../../tools/staging/client.mjs';
import { sshFlow } from '../../tools/staging/ssh-flow.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const config = join(root, 'tests/ssh/wrangler.jsonc');
const wrangler = join(root, 'node_modules/.bin/wrangler');
const crate = join(root, 'backend/crates/yoneda-ssh-gateway');
const SECRET = 'local-ssh-e2e-gateway-secret-0123456789';
const docker = process.argv.includes('--docker');
const direct = process.argv.includes('--direct');
const SSH_HOST = 'ssh.e2e.invalid';
const IMAGE = 'yoneda-ssh-gateway:e2e';

const freePort = () =>
  new Promise((resolve) => {
    const server = createServer().listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });

async function waitFor(url, what, ms = 90_000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await fetch(url).then((r) => r.ok, () => false)) return;
    await sleep(300);
  }
  throw new Error(`${what} did not come up at ${url}`);
}

const dir = mkdtempSync(join(tmpdir(), 'yoneda-ssh-e2e-'));
const children = [];
const start = (cmd, args, options) => {
  const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], ...options });
  let log = '';
  child.stdout.on('data', (c) => (log += c));
  child.stderr.on('data', (c) => (log += c));
  children.push({ child, log: () => log, cmd });
  return child;
};
let failed = false;
try {
  const [http, ssh, health] = [await freePort(), await freePort(), await freePort()];
  for (const t of ['ed25519', 'ecdsa'])
    execFileSync('ssh-keygen', ['-q', '-t', t, '-N', '', '-f', join(dir, `host_${t}`)]);
  const state = join(dir, 'state');
  execFileSync(wrangler, ['d1', 'migrations', 'apply', 'yoneda-ssh-e2e-index', '--local', '-c', config, '--persist-to', state], {
    cwd: root,
    stdio: 'ignore',
    env: { ...process.env, CI: '1' },
  });
  const doorVars = direct ? [] : ['--var', 'SSH_FRONT_DOOR:tunnel', '--var', `SSH_HOST:${SSH_HOST}`];
  start(wrangler, ['dev', '-c', config, '--ip', '127.0.0.1', '--port', String(http), '--persist-to', state, '--show-interactive-dev-session=false', ...doorVars], { cwd: root });
  const origin = `http://127.0.0.1:${http}`;
  await waitFor(`${origin}/health`, 'wrangler dev');

  const hostKeys = {
    SSH_HOST_ED25519_KEY: readFileSync(join(dir, 'host_ed25519'), 'utf8'),
    SSH_HOST_ECDSA_KEY: readFileSync(join(dir, 'host_ecdsa'), 'utf8'),
  };
  // The stand-in cloudflared: records its arguments and whether it got the token (never its value).
  const fake = join(dir, 'cloudflared');
  writeFileSync(fake, `#!/bin/sh\necho "$@" > "${dir}/cloudflared.args"\n[ "$TUNNEL_TOKEN" = e2e-token ] && echo yes > "${dir}/cloudflared.token"\nexec sleep 600\n`);
  chmodSync(fake, 0o755);
  if (docker) {
    const arch = process.arch === 'arm64' ? 'linux/arm64' : 'linux/amd64';
    execFileSync('docker', ['build', '-q', '--platform', arch, '-f', 'cloudflare/ssh-gateway/Dockerfile', '-t', IMAGE, '.'], { cwd: root, stdio: 'ignore' });
    const version = execFileSync('docker', ['run', '--rm', '--entrypoint', '/usr/local/bin/cloudflared', IMAGE, '--version'], { encoding: 'utf8' });
    console.error(`image cloudflared: ${version.trim()}`);
    // Secrets reach the container through the environment of `docker run`, never its arguments.
    start('docker', ['run', '--rm', '-p', `127.0.0.1:${ssh}:2222`, '-p', `127.0.0.1:${health}:8080`, '-e', 'PLATFORM_URL', '-e', 'SSH_GATEWAY_SECRET', '-e', 'SSH_HOST_ED25519_KEY', '-e', 'SSH_HOST_ECDSA_KEY', '-e', 'HEALTH_LISTEN', IMAGE], {
      env: { ...process.env, ...hostKeys, PLATFORM_URL: `http://host.docker.internal:${http}`, SSH_GATEWAY_SECRET: SECRET, HEALTH_LISTEN: '0.0.0.0:8080' },
    });
  } else {
    execFileSync('cargo', ['build', '-q', '--release'], { cwd: crate, stdio: 'inherit' });
    start(join(crate, 'target/release/yoneda-ssh-gateway'), [], {
      env: { ...process.env, ...hostKeys, PLATFORM_URL: origin, SSH_GATEWAY_SECRET: SECRET, SSH_LISTEN: `127.0.0.1:${ssh}`, HEALTH_LISTEN: `127.0.0.1:${health}`, TUNNEL_TOKEN: 'e2e-token', CLOUDFLARED: fake },
    });
  }
  await waitFor(`http://127.0.0.1:${health}/`, 'the SSH gateway', 60_000);

  const account = async (name) => {
    const response = await fetch(`${origin}/api/auth/signup`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: name, password: 'local ssh e2e password' }),
    });
    if (!response.ok) throw new Error(`signup ${name}: ${response.status} ${await response.text()}`);
    return new Session(`${origin}/api/v1`, { cookie: (response.headers.get('set-cookie') ?? '').split(';')[0] });
  };
  const suffix = Date.now().toString(36);
  const metrics = {};
  const proxyOverride = direct ? undefined : `nc 127.0.0.1 ${ssh}`;
  await sshFlow({ platform: await account(`ssh_e2e_${suffix}`), other: await account(`ssh_e2e_o_${suffix}`), sshHost: '127.0.0.1', sshPort: ssh, proxyOverride }, metrics);
  if (!direct && !metrics.via.startsWith('ProxyCommand')) throw new Error(`expected the tunnel ssh_config, got ${metrics.via}`);
  if (!docker) {
    const args = existsSync(join(dir, 'cloudflared.args')) && readFileSync(join(dir, 'cloudflared.args'), 'utf8').trim();
    if (args !== 'tunnel --no-autoupdate run' || !existsSync(join(dir, 'cloudflared.token')))
      throw new Error(`cloudflared was not started as expected: ${args}`);
    metrics.cloudflared = `${args} (token from the environment)`;
  }
  console.log(JSON.stringify({ ok: true, gateway: docker ? 'docker' : 'native', ...metrics }, null, 2));
} catch (e) {
  failed = true;
  console.error(`FAILED: ${e.stack ?? e}`);
  for (const { cmd, log } of children) console.error(`--- ${cmd} (last 3000 bytes)\n${log().slice(-3000)}`);
} finally {
  for (const { child } of children) child.kill('SIGTERM');
  await sleep(500);
  if (docker) execFileSync('docker', ['rmi', '-f', IMAGE], { stdio: 'ignore' });
  rmSync(dir, { recursive: true, force: true });
  process.exit(failed ? 1 : 0);
}
