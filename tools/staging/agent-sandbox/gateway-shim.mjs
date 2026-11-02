// The way Claude Code and Codex reach AI Gateway from the agent sandbox. Both CLIs insist on a
// provider key and send it; the gateway holds the real keys (BYOK), so a placeholder would replace
// them. This listens on the container's loopback, drops every credential the CLI sent, adds the
// gateway's token and forwards through the egress proxy (NODE_USE_ENV_PROXY). Only POST, only the
// model routes and only this run's model pass, so a tool call in the sandbox can't spend on another
// model or read the gateway's other routes. sandbox-agent.sh starts it and unsets its variables
// before the agent starts.
import { createServer } from 'node:http';
import { Readable } from 'node:stream';
import { pathToFileURL } from 'node:url';

export const PORT = 8719;
export const ROUTES = new Set(['/anthropic/v1/messages', '/anthropic/v1/messages/count_tokens', '/openai/responses']);
/** Never forwarded: every provider credential, and what the fetch below sets itself. */
const DROPPED = new Set(['authorization', 'x-api-key', 'api-key', 'cookie', 'proxy-authorization', 'host', 'connection', 'content-length', 'transfer-encoding', 'accept-encoding', 'cf-aig-authorization']);
const HOP_BY_HOP = new Set(['connection', 'keep-alive', 'transfer-encoding', 'content-encoding', 'content-length']);

/** Why `method path` with `body` may not pass, or null. */
export function refusal(method, path, body, model) {
  if (method !== 'POST') return 'only POST';
  if (!ROUTES.has(path)) return `no route ${path}`;
  let asked;
  try {
    asked = JSON.parse(body).model;
  } catch {
    return 'the body is not JSON';
  }
  return asked === model ? null : `this run may use ${model} only, not ${asked}`;
}

/** What the gateway gets: the CLI's headers without any credential, and the gateway's token. */
export function upstreamHeaders(headers, token) {
  const out = {};
  for (const [name, value] of Object.entries(headers)) if (!DROPPED.has(name.toLowerCase())) out[name] = value;
  out['cf-aig-authorization'] = `Bearer ${token}`;
  return out;
}

const answer = (res, status, message) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: { type: 'gateway_shim', message } }));
};

export function serve({ gateway, token, model, port = PORT }) {
  return createServer(async (req, res) => {
    try {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = Buffer.concat(chunks).toString('utf8');
      const url = new URL(req.url, 'http://shim');
      const why = refusal(req.method, url.pathname, body, model);
      if (why) return answer(res, 403, why);
      const upstream = await fetch(`${gateway}${url.pathname}${url.search}`, { method: 'POST', headers: upstreamHeaders(req.headers, token), body });
      const headers = {};
      for (const [name, value] of upstream.headers) if (!HOP_BY_HOP.has(name)) headers[name] = value;
      res.writeHead(upstream.status, headers);
      if (upstream.body) Readable.fromWeb(upstream.body).pipe(res);
      else res.end();
    } catch (e) {
      if (res.headersSent) res.destroy();
      else answer(res, 502, `the gateway did not answer: ${e.message}`);
    }
  }).listen(port, '127.0.0.1');
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const { SANDBOX_GATEWAY_URL: gateway, SANDBOX_GATEWAY_TOKEN: token, SANDBOX_GATEWAY_MODEL: model } = process.env;
  if (!gateway || !token || !model) process.exit(97);
  delete process.env.SANDBOX_GATEWAY_TOKEN;
  serve({ gateway: gateway.replace(/\/$/, ''), token, model });
}
