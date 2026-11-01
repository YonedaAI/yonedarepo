// A client placed in one region (North America, Europe or Asia), for the latency matrix
// (tools/platform-region-matrix.mjs) and the real-use simulation (tools/platform-real-use.mjs).
// Workers can't run Git, so what it sends are the request forms: requests from a client here
// enter Cloudflare here, as a person's or an agent's would, less their own last mile. `ping`
// says where this Worker really runs, `steps` sends requests, to the public platform or to its
// routes running in this region (`serve`), `probe` times each piece, and anything else is the
// bench client's own protocol (bench-client.js), so a burst of writers runs from here too.
import { benchAnswer } from './bench-client.js';
import { here, probe, validProbe } from './region-probe.js';
import { REGION_VERSION, runSteps, servedFrom, validSteps } from './region-steps.js';
import { TARGET } from './requests.js';

const json = (value, status = 200) => Response.json(value, { status });
const SERVE = new Set(['enam', 'weur', 'apac']);

export default {
  async fetch(request, env) {
    if (request.method !== 'POST' || request.headers.get('x-bench-key') !== env.BENCH_KEY) return json({ error: 'forbidden' }, 403);
    const body = await request.json();
    const { target, ping, steps, parallel, serve, probe: asked } = body;
    if (ping === true) return json({ bench: REGION_VERSION, ...(await here()), request_colo: request.cf?.colo ?? null, placement: request.headers.get('cf-placement') });
    if (ping || body.writers || body.relay || body.open) return benchAnswer(request, env, body);
    if (!TARGET.test(target ?? '')) return json({ error: 'bad request' }, 400);
    if (steps !== undefined) {
      if (!validSteps(steps) || (serve !== undefined && !SERVE.has(serve))) return json({ error: 'bad request' }, 400);
      return json({ results: await runSteps(target, steps, parallel === true, serve ? servedFrom(env, serve) : undefined) });
    }
    return validProbe(asked) ? json(await probe(env, target, asked)) : json({ error: 'bad request' }, 400);
  },
};
