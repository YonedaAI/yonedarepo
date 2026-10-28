// Bench client Worker for many concurrent writers (and a webhook receiver, below) (tools/platform-fanout-bench.mjs). One
// laptop cannot hold thousands of open connections and one Worker invocation holds at most
// six, so the driver sends many small batches here: each invocation runs up to five writers
// or readers side by side (commit, then land; or one read) against the target over the
// public internet, or one open-loop arrival stream (open-loop.js), and returns each
// request's client latency and the target's Server-Timing total. Placed in aws:us-east-1,
// next to the platform, so it is also the near-region client.
import { openLoop, parseOpen } from './open-loop.js';
import { commitAndLand, read } from './requests.js';

const json = (value, status = 200) => Response.json(value, { status });
// A read slower than this fails alone: one stuck read held its invocation's other four past
// the driver's 300 s header timeout (item 9, 2026-10-28), losing all five results.
const READ_TIMEOUT_MS = 60_000;
// The deployed client reaches only public addresses (global_fetch_strictly_public); a local
// run of it may target a local platform.
const TARGET = /^(https:\/\/[a-z0-9.-]+|http:\/\/(localhost|127\.0\.0\.1)(:\d+)?)$/;

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
    const { target, repo, writers, open } = await request.json();
    if (!TARGET.test(target ?? '') || !/^r[0-9a-f]{20}$/.test(repo ?? '')) return json({ error: 'bad request' }, 400);
    // Open loop (sustained rate): arrivals on a schedule, apart from completions.
    if (open !== undefined) {
      const parsed = parseOpen(open);
      return parsed ? json(await openLoop(target, repo, parsed)) : json({ error: 'bad request' }, 400);
    }
    if (!Array.isArray(writers) || writers.length > 5) return json({ error: 'bad request' }, 400);
    const results = await Promise.all(
      writers.map((w) => (w.read || w.get ? read(target, repo, w, READ_TIMEOUT_MS) : commitAndLand(target, repo, w))),
    );
    return json({ results });
  },
};
