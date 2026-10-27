// Bench client Worker for many concurrent writers (and a webhook receiver, below) (tools/platform-fanout-bench.mjs). One
// laptop cannot hold thousands of open connections and one Worker invocation holds at most
// six, so the driver sends many small batches here: each invocation runs up to five writers
// side by side (commit, then land) against the target over the public internet, and
// returns each request's client latency and the target's Server-Timing total. Placed in
// aws:us-east-1, next to the platform, so it is also the near-region client.
const json = (value, status = 200) => Response.json(value, { status });

async function timed(url, init) {
  const started = Date.now();
  const at = { started_at: started };
  let response;
  try {
    response = await fetch(url, init);
  } catch (e) {
    // Reported, not thrown: one failed request must not hide the batch's other results.
    return { ...at, status: 0, ms: Date.now() - started, server: null, timing: '', body: { error: { code: 'CLIENT_FETCH', message: String(e?.message ?? e) } } };
  }
  const body = await response.json().catch(() => ({}));
  const timing = response.headers.get('server-timing') ?? '';
  const server = Number(timing.match(/total;dur=([\d.]+)/)?.[1]);
  return { ...at, status: response.status, ms: Date.now() - started, server: Number.isFinite(server) ? server : null, timing, body };
}

// Webhook receiver for the live gate (tools/staging/webhook-flow.mjs): `POST /hooks/<box>`
// is a hook target (no bench key: the platform sends only its signature). With the bench
// key, `PUT` sets the box's secret and how many next deliveries fail with 500, and `GET`
// reads the last 50 deliveries, each checked against the box's secret. One Durable Object
// per box, so every isolate and colo sees the same deliveries.
const BOX = /^\/hooks\/([a-z0-9-]{1,40})$/;
const encoder = new TextEncoder();

async function verified(secret, body, header) {
  const hex = /^sha256=([0-9a-f]{64})$/.exec(header ?? '')?.[1];
  if (!hex) return false;
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
  const bytes = Uint8Array.from(hex.match(/.{2}/g), (h) => Number.parseInt(h, 16));
  return crypto.subtle.verify('HMAC', key, bytes, encoder.encode(body));
}

export class HookBox {
  constructor(state) {
    this.storage = state.storage;
  }
  async fetch(request) {
    if (request.method === 'PUT') {
      const config = await request.json();
      await this.storage.put('config', { secret: String(config.secret ?? ''), fail_next: Number(config.fail_next ?? 0) });
      await this.storage.put('deliveries', []);
      return json({ ok: true });
    }
    const deliveries = (await this.storage.get('deliveries')) ?? [];
    if (request.method === 'GET') return json({ deliveries });
    const body = await request.text();
    if (body.length > 64 * 1024) return json({ error: 'too large' }, 413);
    const config = (await this.storage.get('config')) ?? { secret: '', fail_next: 0 };
    const status = config.fail_next > 0 ? 500 : 200;
    if (status === 500) await this.storage.put('config', { ...config, fail_next: config.fail_next - 1 });
    deliveries.push({
      at: Date.now(),
      status,
      event: request.headers.get('x-yoneda-event'),
      delivery: request.headers.get('x-yoneda-delivery'),
      signature: request.headers.get('x-yoneda-signature'),
      verified: config.secret ? await verified(config.secret, body, request.headers.get('x-yoneda-signature')) : null,
      body,
    });
    await this.storage.put('deliveries', deliveries.slice(-50));
    return new Response(status === 200 ? 'ok' : 'scripted failure', { status });
  }
}

export default {
  async fetch(request, env) {
    const box = BOX.exec(new URL(request.url).pathname)?.[1];
    if (box && env.HOOK_BOXES) {
      const keyed = request.headers.get('x-bench-key') === env.BENCH_KEY;
      if (request.method !== 'POST' && !keyed) return json({ error: 'forbidden' }, 403);
      return env.HOOK_BOXES.get(env.HOOK_BOXES.idFromName(box)).fetch(request);
    }
    if (request.method !== 'POST' || request.headers.get('x-bench-key') !== env.BENCH_KEY)
      return json({ error: 'forbidden' }, 403);
    const { target, repo, writers } = await request.json();
    if (!/^https:\/\/[a-z0-9.-]+$/.test(target) || !Array.isArray(writers) || writers.length > 5)
      return json({ error: 'bad request' }, 400);
    const headers = (w) => ({
      'content-type': 'application/json',
      ...(w.token ? { authorization: `Bearer ${w.token}` } : { cookie: w.cookie }),
    });
    const results = await Promise.all(
      writers.map(async (w) => {
        if (w.read) {
          // Read-your-writes: a reader passes the version its landing reported.
          const since = w.version ? `&min_version=${w.version}` : '';
          const read = await timed(`${target}/api/v1/repos/${repo}/blob?path=${encodeURIComponent(w.path)}${since}`, {
            headers: headers(w),
          });
          const ok = read.status === 200 && read.body.content === w.content;
          return { read: { ...read, ok, error: read.body?.error?.code, message: read.body?.error?.message?.slice(0, 120), body: undefined } };
        }
        const made = await timed(`${target}/api/v1/repos/${repo}/commits`, {
          method: 'POST',
          headers: headers(w),
          body: JSON.stringify({ ref: 'main', changes: [{ path: w.path, content_b64: btoa(w.content) }], message: w.path, author: { name: 'Fanout bench', email: 'bench@yonedarepo.invalid' } }),
        });
        const land =
          made.status === 200
            ? await timed(`${target}/api/v1/repos/${repo}/land`, {
                method: 'POST',
                // The landing mode, honored only where the target allows a per-request choice.
                headers: { ...headers(w), ...(w.mode ? { 'x-yoneda-land-mode': w.mode } : {}) },
                body: JSON.stringify({ ref: 'main', commit: made.body.commit }),
              })
            : null;
        const brief = (r) =>
          r && {
            started_at: r.started_at,
            status: r.status,
            ms: r.ms,
            server: r.server,
            timing: r.timing,
            version: r.body?.version,
            commit: r.body?.commit,
            error: r.body?.error?.code,
            message: r.body?.error?.message?.slice(0, 120),
          };
        return { commit: brief(made), land: brief(land) };
      }),
    );
    return json({ results });
  },
};
