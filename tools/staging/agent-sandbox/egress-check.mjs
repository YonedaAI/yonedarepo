// The agent sandbox's fail-closed egress check (sandbox-agent.sh runs it, as the agent user,
// before the agent): every client's proxy variables must name the proxy probed here, by
// address (no DNS on the way out), the container must reach nothing directly, and the proxy
// must refuse a target outside the allowlist and still answer after a client resets a refused
// tunnel (as opencode does). Any failure exits 97, so no agent starts in a sandbox whose
// egress is wider than the proxy's allowlist or whose proxy it could not use.
import { connect } from 'node:net';

/** Targets no allowlist names: a public name and a public address. */
const PROBES = ['example.com:443', '1.1.1.1:443'];
const TIMEOUT_MS = 3000;

/** Whether a TCP connection to `target` opens straight from this container. */
function reachable(target) {
  const [host, port] = target.split(':');
  return new Promise((resolve) => {
    const socket = connect({ host, port: Number(port), timeout: TIMEOUT_MS });
    const done = (reached) => {
      socket.destroy();
      resolve(reached);
    };
    socket.on('connect', () => done(true));
    socket.on('timeout', () => done(false));
    socket.on('error', () => done(false));
  });
}

/** The proxy's status line for `CONNECT target` ('' when it does not answer); the connection
 * then ends with a TCP reset. */
function throughProxy(proxy, target) {
  const [host, port] = proxy.split(':');
  return new Promise((resolve) => {
    let answer = '';
    const socket = connect({ host, port: Number(port), timeout: TIMEOUT_MS }, () =>
      socket.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`),
    );
    const done = () => {
      if (!socket.destroyed) socket.resetAndDestroy();
      resolve(answer.split('\r\n')[0]);
    };
    socket.on('data', (chunk) => {
      answer += chunk;
      if (answer.includes('\r\n')) done();
    });
    socket.on('timeout', done);
    socket.on('error', done);
    socket.on('end', done);
  });
}

const proxy = process.env.SANDBOX_EGRESS_PROXY ?? '';
const problems = [];
if (!/^\d{1,3}(\.\d{1,3}){3}:\d+$/.test(proxy)) problems.push(`no egress proxy address configured (${proxy || 'unset'})`);
for (const name of ['HTTPS_PROXY', 'HTTP_PROXY', 'https_proxy', 'http_proxy'])
  if (process.env[name] !== `http://${proxy}`) problems.push(`${name} is ${process.env[name] || 'unset'}, not http://${proxy}`);
for (const target of PROBES) if (await reachable(target)) problems.push(`${target} is reachable without the proxy`);
// The first probe again: the proxy must have outlived the resets.
for (const target of [...PROBES, PROBES[0]]) {
  const status = proxy ? await throughProxy(proxy, target) : '';
  if (!/^HTTP\/1\.[01] 403 /.test(status)) problems.push(`the proxy answered "${status || 'nothing'}" for ${target}, not 403`);
}
if (problems.length) {
  console.error(`sandbox egress check: ${problems.join('; ')}`);
  process.exit(97);
}
