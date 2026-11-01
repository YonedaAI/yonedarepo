// What a bench client answers: one small batch of writers or readers, one open-loop arrival
// stream, or a relay of batches. Shared by the client beside the platform (worker.js) and the
// regional clients (region-worker.js), so a burst runs the same from any region. No Node
// imports: this runs in the Worker.
import { openLoop, parseOpen } from './open-loop.js';
import { BENCH_VERSION, fanOut, validRelay } from './relay.js';
import { commitAndLand, read, TARGET } from './requests.js';

const json = (value, status = 200) => Response.json(value, { status });
// A read slower than this fails alone: one stuck read held its invocation's other four past
// the driver's 300 s header timeout (item 9, 2026-10-28), losing all five results.
const READ_TIMEOUT_MS = 60_000;

async function pingSelf(request, env) {
  const answer = await fetch(new URL(request.url).origin, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-bench-key': env.BENCH_KEY },
    body: JSON.stringify({ ping: {} }),
  }).catch(() => null);
  return answer?.ok ? answer.json() : null;
}

/** Answers one keyed bench request; the caller has checked the key. */
export async function benchAnswer(request, env, { target, repo, writers, open, relay, ping }) {
  // The driver's preflight: this version, and (`self`) whether a relay can reach this Worker.
  if (ping) {
    const self = ping.self ? await pingSelf(request, env) : undefined;
    return json({ bench: BENCH_VERSION, relay: self?.bench === BENCH_VERSION || !ping.self });
  }
  if (!TARGET.test(target ?? '')) return json({ error: 'bad request' }, 400);
  // Many batches from one driver request: see relay.js.
  if (relay !== undefined) {
    if (!validRelay(relay)) return json({ error: 'bad request' }, 400);
    return json({ batches: await fanOut({ origin: new URL(request.url).origin, key: env.BENCH_KEY, target, batches: relay }) });
  }
  if (!/^r[0-9a-f]{20}$/.test(repo ?? '')) return json({ error: 'bad request' }, 400);
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
}
