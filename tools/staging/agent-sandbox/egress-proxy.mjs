// The agent sandbox's egress proxy (tools/staging/agent-sandbox.mjs). Agent containers sit on
// an internal Docker network with no route out; this proxy is their only way to anything
// beyond it, and it reaches only the `host:port` targets of $SANDBOX_EGRESS_ALLOW (the model
// provider's API and the platform), by exact name. HTTPS goes through CONNECT, plain HTTP
// (a platform on the host's loopback) as absolute-form requests. Every refusal is logged as
// one JSON line, so a run shows what an agent tried to reach. Every socket has an error
// handler: a client's reset (opencode drops a refused tunnel that way) must end that one
// connection, never the proxy every agent depends on.
import { connect } from 'node:net';
import { createServer, request } from 'node:http';

export const PORT = 3128;

/** The allowlist out of `SANDBOX_EGRESS_ALLOW` (`host:port,host:port`). */
export function parseAllow(text) {
  const allow = new Set();
  for (const entry of String(text ?? '').split(',').map((e) => e.trim().toLowerCase()).filter(Boolean)) {
    if (!/^[a-z0-9.-]+:\d{1,5}$/.test(entry)) throw new Error(`egress allowlist entry is not host:port: ${entry}`);
    allow.add(entry);
  }
  return allow;
}

/** The `host:port` a request targets: a CONNECT authority, or an absolute-form URL's. */
export function targetOf(method, url) {
  if (method === 'CONNECT') {
    const match = /^([a-z0-9.-]+):(\d{1,5})$/i.exec(url);
    return match ? `${match[1].toLowerCase()}:${match[2]}` : null;
  }
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:') return null;
    return `${parsed.hostname.toLowerCase()}:${parsed.port || '80'}`;
  } catch {
    return null;
  }
}

/** Whether the proxy forwards `method url` under `allow`: only an exact listed target. */
export const allowed = (method, url, allow) => {
  const target = targetOf(method, url);
  return target !== null && allow.has(target);
};

const logLine = (event) => console.log(JSON.stringify(event));

/** The proxy on `port` (0: any free one), logging its events through `log`. */
export function serve(allow, port = PORT, log = logLine) {
  const refuse = (target, method) => log({ event: 'egress.refused', method, target });
  const server = createServer((req, res) => {
    if (!allowed(req.method, req.url, allow)) {
      refuse(targetOf(req.method, req.url) ?? req.url, req.method);
      res.writeHead(403, { 'content-type': 'text/plain' }).end('egress refused by the sandbox\n');
      return;
    }
    const url = new URL(req.url);
    const upstream = request(
      { host: url.hostname, port: url.port || 80, method: req.method, path: `${url.pathname}${url.search}`, headers: req.headers },
      (answer) => {
        res.writeHead(answer.statusCode ?? 502, answer.headers);
        answer.on('error', () => res.destroy());
        answer.pipe(res);
      },
    );
    // Once the answer has begun, a 502 can no longer be sent: the client sees the cut instead.
    upstream.on('error', () => (res.headersSent ? res.destroy() : res.writeHead(502).end()));
    req.on('error', () => upstream.destroy());
    req.pipe(upstream);
  });
  // The http server stops handling a CONNECT socket's errors once it hands the socket here.
  server.on('connect', (req, socket, head) => {
    let upstream = null;
    socket.on('error', () => upstream?.destroy());
    if (!allowed('CONNECT', req.url, allow)) {
      refuse(targetOf('CONNECT', req.url) ?? req.url, 'CONNECT');
      socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
      return;
    }
    const [host, port] = targetOf('CONNECT', req.url).split(':');
    let open = false;
    upstream = connect(Number(port), host, () => {
      open = true;
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      upstream.write(head);
      upstream.pipe(socket);
      socket.pipe(upstream);
    });
    upstream.on('error', () => (open ? socket.destroy() : socket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n')));
  });
  return server.listen(port, () => log({ event: 'egress.listening', port: server.address().port, allow: [...allow] }));
}

if (import.meta.url === `file://${process.argv[1]}`) serve(parseAllow(process.env.SANDBOX_EGRESS_ALLOW));
