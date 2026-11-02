// A dev-only way to MiMo for demo-repos.mjs: the MiMo key stays in the Secrets Store, this Worker
// sends it to AI Gateway as the managed harness does (cloudflare/managed/harness.ts), and an agent
// in the sandbox holds only PROXY_TOKEN, good for this one route and model. Delete the Worker when
// the demo is done: wrangler delete --config tools/staging/model-proxy/wrangler.jsonc
const MODEL = 'mimo-v2.6-flash';
const ROUTE = '/anthropic/v1/messages';

const refuse = (status, code) => Response.json({ error: { type: code, message: code } }, { status });

/** Constant-time text compare: the bearer is the only thing between the internet and the key. */
async function same(a, b) {
  const digest = (text) => crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  const [x, y] = await Promise.all([digest(a), digest(b)]);
  return crypto.subtle.timingSafeEqual(x, y);
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (req.method !== 'POST') return refuse(405, 'METHOD_NOT_ALLOWED');
    if (url.pathname !== ROUTE) return refuse(404, 'NOT_FOUND');
    const given = req.headers.get('x-api-key') ?? '';
    if (!env.PROXY_TOKEN || !(await same(given, env.PROXY_TOKEN))) return refuse(401, 'UNAUTHORIZED');
    const text = await req.text();
    let model;
    try {
      ({ model } = JSON.parse(text));
    } catch {
      return refuse(400, 'INVALID_JSON');
    }
    if (model !== MODEL) return refuse(403, 'MODEL_NOT_ALLOWED');
    const headers = new Headers({ 'content-type': 'application/json', 'anthropic-version': req.headers.get('anthropic-version') ?? '2023-06-01' });
    const beta = req.headers.get('anthropic-beta');
    if (beta) headers.set('anthropic-beta', beta);
    headers.set('api-key', await env.MIMO_KEY.get());
    headers.set('cf-aig-authorization', `Bearer ${env.AI_GATEWAY_TOKEN}`);
    headers.set('cf-aig-metadata', JSON.stringify({ agent: 'demo-repos' }));
    return fetch(`${env.AI_GATEWAY_URL}/custom-mimo${ROUTE}`, { method: 'POST', headers, body: text, redirect: 'manual' });
  },
};
